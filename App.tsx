import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Search, Music2, Play, Trophy, AlertCircle, Loader2, ArrowLeft, Youtube } from 'lucide-react';
import { SongData, GameStatus, ScoreState, SearchResult } from './types';
import { searchYoutubeSongs, generateSongChart } from './services/geminiService';
import { autoCorrelate, frequencyToMidi } from './services/audioAnalysis';
import PitchVisualizer from './components/PitchVisualizer';
import AudienceMeter from './components/AudienceMeter';

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<GameStatus>(GameStatus.IDLE);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [songData, setSongData] = useState<SongData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMicReady, setIsMicReady] = useState(false);
  
  // Game Logic State
  const [currentTime, setCurrentTime] = useState(0);
  const [userPitch, setUserPitch] = useState(0);
  const [scoreState, setScoreState] = useState<ScoreState>({
    currentScore: 0,
    combo: 0,
    maxCombo: 0,
    perfectHits: 0,
    goodHits: 0,
    misses: 0,
    audienceMood: 50
  });

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const microphoneRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const requestRef = useRef<number>();
  const startTimeRef = useRef<number>(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // --- Audio Handling (Microphone) ---
  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
      
      microphoneRef.current = audioContextRef.current.createMediaStreamSource(stream);
      microphoneRef.current.connect(analyserRef.current);
      
      setIsMicReady(true);
      return true;
    } catch (err) {
      console.error("Microphone error:", err);
      setError("Could not access microphone. Please allow permissions.");
      return false;
    }
  };

  const stopMicrophone = () => {
    if (microphoneRef.current) {
      microphoneRef.current.disconnect();
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    setIsMicReady(false);
  };

  // --- Game Loop ---
  const updatePitch = useCallback(() => {
    if (!analyserRef.current || status !== GameStatus.PLAYING) return;

    const bufferLength = analyserRef.current.fftSize;
    const buffer = new Float32Array(bufferLength);
    analyserRef.current.getFloatTimeDomainData(buffer);

    const freq = autoCorrelate(buffer, audioContextRef.current!.sampleRate);
    
    // Noise gate and range check
    if (freq > 80 && freq < 1200) {
      setUserPitch(freq);
    } else {
      setUserPitch(0);
    }
  }, [status]);

  const updateGame = useCallback(() => {
    if (status !== GameStatus.PLAYING || !songData) return;

    // 1. Update Time
    const now = Date.now();
    const elapsed = (now - startTimeRef.current) / 1000;
    setCurrentTime(elapsed);

    // 2. Update Pitch
    updatePitch();

    // 3. Scoring Logic
    const userMidi = frequencyToMidi(userPitch);
    
    // Find active note
    const activeNote = songData.notes.find(n => elapsed >= n.startTime && elapsed <= n.startTime + n.duration);

    setScoreState(prev => {
      let newState = { ...prev };

      if (activeNote) {
        // Check if user is singing
        if (userPitch > 0) {
          const diff = Math.abs(userMidi - activeNote.pitch);
          
          if (diff < 1.0) {
            // Perfect hit
            newState.currentScore += 10 + (prev.combo * 2);
            newState.combo += 1;
            newState.perfectHits += 1;
            newState.audienceMood = Math.min(100, prev.audienceMood + 0.5);
          } else if (diff < 2.5) {
            // Good hit (allow some tolerance)
            newState.currentScore += 5;
            newState.combo += 1; // Keep combo but less score
            newState.goodHits += 1;
            newState.audienceMood = Math.min(100, prev.audienceMood + 0.1);
          } else {
             // Singing wrong note
             newState.combo = 0;
             newState.misses += 1;
             newState.audienceMood = Math.max(0, prev.audienceMood - 0.2);
          }
        } else {
           // Not singing during a note
           // Don't punish too hard for breathing, but break combo if gap is long?
           newState.audienceMood = Math.max(0, prev.audienceMood - 0.05);
        }
      } else {
        // Singing when no note? (Freestyling)
        // No penalty
      }

      newState.maxCombo = Math.max(newState.maxCombo, newState.combo);
      
      // Game Over check logic can go here (optional)

      return newState;
    });

    requestRef.current = requestAnimationFrame(updateGame);
  }, [status, songData, userPitch, updatePitch]);

  useEffect(() => {
    if (status === GameStatus.PLAYING) {
      requestRef.current = requestAnimationFrame(updateGame);
    } else {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [status, updateGame]);


  // --- Handlers ---

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setStatus(GameStatus.SEARCHING);
    setError(null);
    setSearchResults([]);

    try {
      const results = await searchYoutubeSongs(searchQuery);
      if (results.length === 0) {
        setError("No results found. Try a different query.");
        setStatus(GameStatus.IDLE);
        return;
      }
      setSearchResults(results);
      setStatus(GameStatus.SELECTING);
    } catch (err) {
      setError("Failed to search songs.");
      setStatus(GameStatus.IDLE);
    }
  };

  const handleSelectSong = async (song: SearchResult) => {
    setStatus(GameStatus.PREPARING);
    setSongData(null);
    try {
      const data = await generateSongChart(song);
      setSongData(data);
    } catch (err) {
      setError("Failed to generate chart for selected song.");
      setStatus(GameStatus.SELECTING);
    }
  };

  const startGame = async () => {
    const micAccess = await startMicrophone();
    if (!micAccess) return;

    // Start timer
    startTimeRef.current = Date.now();
    setStatus(GameStatus.PLAYING);
    
    // Reset Score
    setScoreState({
      currentScore: 0,
      combo: 0,
      maxCombo: 0,
      perfectHits: 0,
      goodHits: 0,
      misses: 0,
      audienceMood: 50
    });
  };

  const resetGame = () => {
    setStatus(GameStatus.IDLE);
    stopMicrophone();
    setSongData(null);
    setSearchQuery('');
    setSearchResults([]);
  };

  const goBackToSearch = () => {
    setStatus(GameStatus.IDLE);
    setSearchResults([]);
  };

  // --- Renders ---

  const renderSearching = () => (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <Loader2 className="animate-spin text-blue-400" size={48} />
      <p className="text-xl font-semibold text-slate-300">Searching YouTube...</p>
      <p className="text-sm text-slate-500">Finding the best karaoke tracks</p>
    </div>
  );

  const renderSelecting = () => (
    <div className="w-full max-w-5xl flex flex-col gap-6 animate-fade-in pb-10">
      <div className="flex items-center gap-4 mb-4">
        <button 
          onClick={goBackToSearch}
          className="p-2 hover:bg-slate-800 rounded-full transition-colors"
        >
          <ArrowLeft className="text-slate-400" />
        </button>
        <h2 className="text-2xl font-bold text-white">Select a Version</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {searchResults.map((result) => (
          <div 
            key={result.videoId}
            onClick={() => handleSelectSong(result)}
            className="group bg-slate-800 rounded-xl overflow-hidden cursor-pointer border border-slate-700 hover:border-blue-500 transition-all hover:shadow-blue-500/20 hover:shadow-xl hover:-translate-y-1"
          >
            {/* Thumbnail */}
            <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
               <img 
                 src={`https://img.youtube.com/vi/${result.videoId}/mqdefault.jpg`} 
                 alt={result.title}
                 className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
               />
               <div className="absolute inset-0 bg-black/20 group-hover:bg-transparent transition-colors" />
               <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                 <Youtube size={12} className="text-red-500" />
                 Karaoke
               </div>
            </div>
            
            {/* Content */}
            <div className="p-4">
              <h3 className="font-bold text-white mb-1 line-clamp-2 leading-tight group-hover:text-blue-400 transition-colors">
                {result.title}
              </h3>
              <p className="text-slate-400 text-sm mb-2">{result.artist}</p>
              {result.channelName && (
                <p className="text-slate-500 text-xs flex items-center gap-1">
                  <div className="w-4 h-4 rounded-full bg-slate-700" />
                  {result.channelName}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderPreparing = () => {
    if (!songData) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
                <Loader2 className="animate-spin text-purple-400" size={48} />
                <p className="text-xl font-semibold text-slate-300">Generating Note Chart...</p>
                <p className="text-sm text-slate-500">AI is analyzing the melody structure</p>
            </div>
        );
    }
    return (
      <div className="flex flex-col items-center gap-6 max-w-2xl w-full animate-fade-in">
        <div className="w-full flex justify-start">
             <button onClick={() => setStatus(GameStatus.SELECTING)} className="text-slate-400 hover:text-white flex items-center gap-2 mb-2">
                <ArrowLeft size={20} /> Back to results
             </button>
        </div>
        <div className="bg-slate-800 p-6 rounded-2xl w-full border border-slate-700 shadow-2xl">
          <h2 className="text-3xl font-bold text-white mb-2">{songData.title}</h2>
          <p className="text-lg text-blue-400 mb-6">{songData.artist} • {songData.difficulty}</p>
          
          <div className="bg-slate-900 rounded-lg p-4 mb-6 text-slate-400 text-sm">
            <p className="mb-2"><span className="text-yellow-400 font-bold">⚠️ Technical Note:</span></p>
            <p>
              Due to browser security (CORS), we cannot analyze the YouTube audio directly.
              <br/>
              1. The <strong>Music</strong> comes from YouTube.
              <br/>
              2. The <strong>Pitch Bars</strong> are generated by AI based on the song data.
              <br/>
              3. <strong>Your Voice</strong> is analyzed in real-time using your microphone.
            </p>
            <p className="mt-2 text-xs italic">Sync might not be perfect. Adjust your timing!</p>
          </div>

          <button 
            onClick={startGame}
            className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white font-bold py-4 rounded-xl text-xl flex items-center justify-center gap-3 transition-transform hover:scale-[1.02]"
          >
            <Mic size={24} />
            START SINGING
          </button>
        </div>
      </div>
    );
  };

  const renderPlaying = () => {
    if (!songData) return null;
    
    return (
      <div className="relative w-full h-[calc(100vh-80px)] flex flex-col overflow-hidden bg-black rounded-3xl border-4 border-slate-800 shadow-2xl animate-fade-in">
        
        {/* Top UI Overlay */}
        <div className="absolute top-0 left-0 right-0 z-20 p-4 flex justify-between items-start bg-gradient-to-b from-black/80 to-transparent">
           <div className="flex flex-col">
              <h3 className="text-xl font-bold text-white shadow-black drop-shadow-md">{songData.title}</h3>
              <p className="text-sm text-slate-300">{songData.artist}</p>
           </div>
           
           <div className="flex flex-col items-end">
              <span className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-yellow-600 drop-shadow-sm">
                {Math.floor(scoreState.currentScore).toLocaleString()}
              </span>
              <span className="text-xs font-bold text-slate-400 uppercase">Score</span>
           </div>
        </div>

        {/* Audience Meter Overlay (Left Center) */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
            <AudienceMeter mood={scoreState.audienceMood} combo={scoreState.combo} />
        </div>

        {/* Main Pitch Visualizer Layer (Middle) */}
        <div className="absolute inset-0 z-10 pointer-events-none">
           <PitchVisualizer 
              currentTime={currentTime}
              userPitch={userPitch}
              notes={songData.notes}
              scoreState={scoreState}
              isPlaying={status === GameStatus.PLAYING}
           />
        </div>

        {/* YouTube Video Background */}
        <div className="absolute inset-0 z-0 opacity-60">
           <iframe 
            ref={iframeRef}
            width="100%" 
            height="100%" 
            src={`https://www.youtube.com/embed/${songData.videoId}?autoplay=1&controls=0&modestbranding=1&rel=0&start=0`}
            title="YouTube video player" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
            className="pointer-events-none w-full h-full object-cover"
           />
        </div>

        {/* Stop Button */}
        <button 
          onClick={resetGame}
          className="absolute bottom-6 right-6 z-30 bg-red-600/80 hover:bg-red-500 p-3 rounded-full text-white backdrop-blur-sm transition-all"
        >
          <div className="w-4 h-4 bg-white rounded-sm" />
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-[#0f172a]/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer" onClick={resetGame}>
          <div className="bg-gradient-to-br from-blue-500 to-purple-600 p-2 rounded-lg">
            <Music2 size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400 hidden sm:block">
            KaraokeGenius
          </h1>
        </div>
        
        {status === GameStatus.IDLE && (
           <div className="text-xs font-mono text-slate-500 bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
             MIC: {isMicReady ? 'ACTIVE' : 'OFF'}
           </div>
        )}
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-start p-6 overflow-hidden">
        
        {/* IDLE State: Search */}
        {status === GameStatus.IDLE && (
          <div className="w-full max-w-3xl flex flex-col items-center mt-20 text-center animate-fade-in">
            <h2 className="text-5xl font-black mb-6 text-white tracking-tight">
              Sing Like a <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">Star</span>
            </h2>
            <p className="text-slate-400 text-lg mb-12 max-w-xl">
              Search for any song. AI generates the track. You provide the voice.
              Real-time pitch detection and scoring.
            </p>

            <div className="relative w-full max-w-xl group">
              <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200"></div>
              <div className="relative flex items-center bg-slate-900 border border-slate-700 rounded-xl p-2 shadow-2xl">
                <Search className="text-slate-400 ml-3" />
                <input 
                  type="text" 
                  className="bg-transparent border-none outline-none text-white text-lg w-full px-4 py-3 placeholder-slate-500"
                  placeholder="Enter song name and artist..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button 
                  onClick={handleSearch}
                  className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
                >
                  Search
                </button>
              </div>
            </div>

            <div className="mt-12 flex gap-8 text-slate-500">
               <div className="flex flex-col items-center gap-2">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700">
                    <Mic size={20} className="text-blue-400" />
                  </div>
                  <span className="text-xs font-medium">Pitch Detection</span>
               </div>
               <div className="flex flex-col items-center gap-2">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700">
                    <Trophy size={20} className="text-yellow-400" />
                  </div>
                  <span className="text-xs font-medium">Live Scoring</span>
               </div>
               <div className="flex flex-col items-center gap-2">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700">
                    <AlertCircle size={20} className="text-purple-400" />
                  </div>
                  <span className="text-xs font-medium">AI Charts</span>
               </div>
            </div>
          </div>
        )}

        {status === GameStatus.SEARCHING && renderSearching()}
        
        {status === GameStatus.SELECTING && renderSelecting()}

        {status === GameStatus.PREPARING && renderPreparing()}
        
        {status === GameStatus.PLAYING && renderPlaying()}

        {error && (
          <div className="mt-8 bg-red-900/50 border border-red-500/50 text-red-200 px-6 py-4 rounded-xl flex items-center gap-3 animate-pulse">
            <AlertCircle size={24} />
            <p>{error}</p>
          </div>
        )}

      </main>
    </div>
  );
};

export default App;