import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Search, Music2, Play, Trophy, AlertCircle, Loader2, ArrowLeft, Youtube, Settings2, Plus, Minus, Database, FileText, Image as ImageIcon, Zap } from 'lucide-react';
import { SongData, GameStatus, ScoreState, SearchResult, Difficulty } from './types';
import { searchYoutubeSongs, generateSongChart } from './services/geminiService';
import { autoCorrelate, frequencyToMidi } from './services/audioAnalysis';
import { searchUsdb, fetchUsdbContent } from './services/usdbService';
import { parseUltraStarTxt } from './services/ultraStarParser';
import PitchVisualizer from './components/PitchVisualizer';
import AudienceMeter from './components/AudienceMeter';

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<GameStatus>(GameStatus.IDLE);
  const [searchMode, setSearchMode] = useState<'AI' | 'USDB'>('USDB'); // Default to USDB
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [songData, setSongData] = useState<SongData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMicReady, setIsMicReady] = useState(false);
  
  // Settings
  const [difficultyMode, setDifficultyMode] = useState<Difficulty>('Novice');
  
  // Manual TXT Paste State
  const [showTxtPaste, setShowTxtPaste] = useState(false);
  const [manualTxt, setManualTxt] = useState('');

  // Game Logic State
  const [audioDelay, setAudioDelay] = useState(0); // In seconds. Positive = shift chart earlier.
  const [effectiveTime, setEffectiveTime] = useState(0);
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
  const requestRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // --- Audio Handling (Microphone) ---
  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive'
      });
      
      // Ensure context is running (required by some browsers)
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

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
    if (freq > 70 && freq < 1400) {
      setUserPitch(freq);
    } else {
      setUserPitch(0);
    }
  }, [status]);

  const updateGame = useCallback(() => {
    if (status !== GameStatus.PLAYING || !songData) return;

    // 1. Update Time
    const now = Date.now();
    const rawElapsed = (now - startTimeRef.current) / 1000;
    
    // Apply user calibrated delay
    const calculatedTime = rawElapsed + audioDelay;
    
    setEffectiveTime(calculatedTime);

    // 2. Update Pitch
    updatePitch();

    // 3. Scoring Logic
    const userMidi = frequencyToMidi(userPitch);
    
    // Find active note based on CALIBRATED time
    const activeNote = songData.notes.find(n => calculatedTime >= n.startTime && calculatedTime <= n.startTime + n.duration);

    setScoreState(prev => {
      let newState = { ...prev };

      if (activeNote) {
        // Check if user is singing
        if (userPitch > 0) {
          let diff = Math.abs(userMidi - activeNote.pitch);

          // Octave Tolerance for Novice Mode
          if (difficultyMode === 'Novice') {
             const diffOctaveDown = Math.abs((userMidi + 12) - activeNote.pitch);
             const diffOctaveUp = Math.abs((userMidi - 12) - activeNote.pitch);
             const diffOctaveDown2 = Math.abs((userMidi + 24) - activeNote.pitch); // Deep voice support
             const diffOctaveUp2 = Math.abs((userMidi - 24) - activeNote.pitch);
             
             diff = Math.min(diff, diffOctaveDown, diffOctaveUp, diffOctaveDown2, diffOctaveUp2);
          }
          
          if (diff < 1.5) {
            // Perfect hit (slightly more lenient in general for web mic latency)
            newState.currentScore += 10 + (prev.combo * 2);
            newState.combo += 1;
            newState.perfectHits += 1;
            newState.audienceMood = Math.min(100, prev.audienceMood + 0.5);
          } else if (diff < 3.0) {
            // Good hit
            newState.currentScore += 5;
            newState.combo += 1;
            newState.goodHits += 1;
            newState.audienceMood = Math.min(100, prev.audienceMood + 0.1);
          } else {
             // Miss
             newState.combo = 0;
             newState.misses += 1;
             newState.audienceMood = Math.max(0, prev.audienceMood - 0.2);
          }
        } else {
           newState.audienceMood = Math.max(0, prev.audienceMood - 0.05);
        }
      }

      newState.maxCombo = Math.max(newState.maxCombo, newState.combo);
      
      return newState;
    });

    requestRef.current = requestAnimationFrame(updateGame);
  }, [status, songData, userPitch, updatePitch, audioDelay, difficultyMode]);

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

  // Keyboard Shortcuts for Sync
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (status !== GameStatus.PLAYING) return;
        
        if (e.key === 'ArrowRight') {
            setAudioDelay(prev => Math.min(prev + 0.05, 5.0));
        } else if (e.key === 'ArrowLeft') {
            setAudioDelay(prev => Math.max(prev - 0.05, -5.0));
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status]);


  // --- Handlers ---

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setStatus(GameStatus.SEARCHING);
    setError(null);
    setSearchResults([]);

    try {
      if (searchMode === 'USDB') {
          const results = await searchUsdb(searchQuery);
          if (results.length === 0) {
              setError("No results found on USDB. Try 'Paste TXT' if you have the file.");
              setStatus(GameStatus.IDLE);
              return;
          }
          setSearchResults(results);
          setStatus(GameStatus.SELECTING);
      } else {
          // AI Mode
          const results = await searchYoutubeSongs(searchQuery);
          if (results.length === 0) {
            setError("No results found.");
            setStatus(GameStatus.IDLE);
            return;
          }
          setSearchResults(results);
          setStatus(GameStatus.SELECTING);
      }
    } catch (err) {
      setError("Failed to search.");
      setStatus(GameStatus.IDLE);
    }
  };

  const handleSelectSong = async (song: SearchResult) => {
    setStatus(GameStatus.PREPARING);
    setSongData(null);
    
    try {
      if (searchMode === 'USDB') {
         // Fetch Content (TXT + Scraped Metadata) from USDB
         if (!song.id) throw new Error("Invalid USDB ID");
         
         const { txt, extraVideoId, extraCoverUrl } = await fetchUsdbContent(song.id);
         
         if (!txt) {
             throw new Error("Could not fetch song data. USDB entry might be private.");
         }
         
         const parsedData = parseUltraStarTxt(txt);
         
         // Prioritize the Video ID found in the HTML if the TXT file was missing it
         if (!parsedData.videoId && extraVideoId) {
             console.log("Using Video ID found in USDB HTML:", extraVideoId);
             parsedData.videoId = extraVideoId;
         }
         
         // Use the cover URL from HTML if not in TXT
         if (!parsedData.coverUrl && extraCoverUrl) {
             parsedData.coverUrl = extraCoverUrl;
         }

         if (!parsedData.videoId) {
             // Fallback only if absolutely necessary
             console.log("No video ID in TXT or USDB Page, searching YouTube...");
             const ytResults = await searchYoutubeSongs(`${parsedData.artist} ${parsedData.title} karaoke`);
             if (ytResults.length > 0) {
                 parsedData.videoId = ytResults[0].videoId;
             }
         }
         
         setSongData(parsedData);

      } else {
         // AI Mode
         const data = await generateSongChart(song);
         setSongData(data);
      }
    } catch (err) {
      console.error(err);
      setError("Failed to load song. " + (err instanceof Error ? err.message : ""));
      // If USDB failed, suggest pasting
      if (searchMode === 'USDB') {
          setShowTxtPaste(true);
      }
      setStatus(GameStatus.SELECTING);
    }
  };
  
  const handleManualPaste = async () => {
      if (!manualTxt.trim()) return;
      try {
          const parsedData = parseUltraStarTxt(manualTxt);
          if (!parsedData.videoId) {
             // Try to find video if missing
             const ytResults = await searchYoutubeSongs(`${parsedData.artist} ${parsedData.title} karaoke`);
             if (ytResults.length > 0) {
                 parsedData.videoId = ytResults[0].videoId;
             } else {
                 throw new Error("No #VIDEO tag found and could not find YouTube video automatically.");
             }
          }
          setSongData(parsedData);
          setStatus(GameStatus.PREPARING);
          setShowTxtPaste(false);
      } catch (err) {
          setError("Invalid UltraStar TXT: " + (err instanceof Error ? err.message : "Unknown error"));
      }
  };

  const startGame = async () => {
    const micAccess = await startMicrophone();
    if (!micAccess) return;

    startTimeRef.current = Date.now();
    setAudioDelay(0);
    setStatus(GameStatus.PLAYING);
    
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
    setShowTxtPaste(false);
    setManualTxt('');
  };

  const goBackToSearch = () => {
    setStatus(GameStatus.IDLE);
    setSearchResults([]);
  };

  // --- Renders ---

  const renderSearching = () => (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <Loader2 className="animate-spin text-blue-400" size={48} />
      <p className="text-xl font-semibold text-slate-300">
          {searchMode === 'USDB' ? 'Searching Animux database...' : 'Searching YouTube...'}
      </p>
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
            key={result.videoId || result.id}
            onClick={() => handleSelectSong(result)}
            className="group bg-slate-800 rounded-xl overflow-hidden cursor-pointer border border-slate-700 hover:border-blue-500 transition-all hover:shadow-blue-500/20 hover:shadow-xl hover:-translate-y-1"
          >
            {/* Thumbnail */}
            <div className="relative aspect-video w-full overflow-hidden bg-slate-900 flex items-center justify-center">
               {result.videoId ? (
                   <img 
                     src={`https://img.youtube.com/vi/${result.videoId}/mqdefault.jpg`} 
                     alt={result.title}
                     className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                   />
               ) : (
                   <div className="flex flex-col items-center justify-center gap-2">
                       <Database size={48} className="text-slate-600 group-hover:text-green-500 transition-colors" />
                       <span className="text-xs text-slate-500 uppercase font-bold tracking-widest">Click to Load</span>
                   </div>
               )}
               
               <div className="absolute inset-0 bg-black/20 group-hover:bg-transparent transition-colors" />
               <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                 {result.source === 'USDB' ? (
                     <>
                        <FileText size={12} className="text-green-500" />
                        USDB
                     </>
                 ) : (
                     <>
                        <Youtube size={12} className="text-red-500" />
                        Karaoke
                     </>
                 )}
               </div>
            </div>
            
            {/* Content */}
            <div className="p-4">
              <h3 className="font-bold text-white mb-1 line-clamp-2 leading-tight group-hover:text-blue-400 transition-colors">
                {result.title}
              </h3>
              <p className="text-slate-400 text-sm mb-2">{result.artist}</p>
            </div>
          </div>
        ))}
      </div>
      
      {searchMode === 'USDB' && (
          <div className="w-full flex justify-center mt-8">
              <button 
                onClick={() => setShowTxtPaste(true)}
                className="text-slate-400 hover:text-white underline text-sm"
              >
                  Can't find it? Paste UltraStar TXT manually
              </button>
          </div>
      )}
    </div>
  );

  const renderPreparing = () => {
    if (!songData) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
                <Loader2 className="animate-spin text-purple-400" size={48} />
                <p className="text-xl font-semibold text-slate-300">Preparing Song...</p>
                <div className="flex flex-col items-center gap-1 text-sm text-slate-500">
                    {searchMode === 'USDB' ? (
                        <p>Fetching song data from USDB...</p>
                    ) : (
                        <p>Generating chart with AI...</p>
                    )}
                </div>
            </div>
        );
    }
    return (
      <div className="flex flex-col items-center gap-6 max-w-2xl w-full animate-fade-in relative z-10">
        <div className="w-full flex justify-start">
             <button onClick={() => setStatus(GameStatus.IDLE)} className="text-slate-400 hover:text-white flex items-center gap-2 mb-2">
                <ArrowLeft size={20} /> Back to Search
             </button>
        </div>
        
        {/* Main Card */}
        <div className="bg-slate-800 p-6 rounded-2xl w-full border border-slate-700 shadow-2xl overflow-hidden relative">
          
          {/* Cover Art Background Effect */}
          {songData.coverUrl && (
              <div 
                className="absolute inset-0 z-0 opacity-20 pointer-events-none blur-xl"
                style={{ backgroundImage: `url(${songData.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              />
          )}

          <div className="relative z-10">
            <div className="flex gap-4 items-start mb-6">
                {songData.coverUrl ? (
                    <img src={songData.coverUrl} alt="Cover" className="w-24 h-24 rounded-lg shadow-lg object-cover border border-white/10" />
                ) : (
                    <div className="w-24 h-24 rounded-lg bg-slate-700 flex items-center justify-center shadow-lg border border-white/10">
                        <Music2 size={32} className="text-slate-500" />
                    </div>
                )}
                <div>
                    <h2 className="text-3xl font-bold text-white mb-2 leading-tight">{songData.title}</h2>
                    <p className="text-lg text-blue-400">{songData.artist}</p>
                    {songData.sourceType === 'USDB' && (
                        <div className="mt-2 flex gap-2">
                             <span className="bg-green-900/80 text-green-400 border border-green-500/50 text-xs px-2 py-1 rounded font-mono">
                                USDB SOURCE
                             </span>
                        </div>
                    )}
                </div>
            </div>

            {/* Difficulty Toggle */}
            <div className="bg-slate-900/60 rounded-xl p-4 mb-4 border border-white/5">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                        <Zap size={16} className={difficultyMode === 'Novice' ? 'text-green-400' : 'text-purple-400'}/>
                        Difficulty Mode
                    </span>
                </div>
                <div className="flex bg-slate-800 p-1 rounded-lg">
                    <button 
                        onClick={() => setDifficultyMode('Novice')}
                        className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${difficultyMode === 'Novice' ? 'bg-green-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                    >
                        Novice
                        <span className="block text-[10px] opacity-70 font-normal">Octave Tolerant</span>
                    </button>
                    <button 
                        onClick={() => setDifficultyMode('Pro')}
                        className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${difficultyMode === 'Pro' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                    >
                        Pro
                        <span className="block text-[10px] opacity-70 font-normal">Exact Pitch</span>
                    </button>
                </div>
                <p className="text-xs text-slate-500 mt-2 text-center">
                    {difficultyMode === 'Novice' 
                        ? "Sing comfortably! Hitting the note in ANY octave counts as a hit." 
                        : "Challenge yourself! You must match the exact pitch of the original song."}
                </p>
            </div>
            
            <div className="bg-slate-900/80 rounded-lg p-4 mb-6 border border-slate-700 backdrop-blur-sm">
               <div className="flex items-center gap-2 mb-2 text-yellow-400">
                  <Settings2 size={18} />
                  <span className="font-bold uppercase text-xs tracking-wider">Calibration Info</span>
               </div>
               <p className="text-slate-400 text-sm leading-relaxed">
                 Timing might vary based on your browser and the YouTube version.
               </p>
               <div className="mt-3 flex items-center gap-3 text-sm text-slate-300 bg-slate-800 p-2 rounded">
                  <div className="flex gap-1">
                      <kbd className="px-2 py-1 bg-slate-700 rounded text-xs border border-slate-600">←</kbd>
                  </div>
                  <div className="flex gap-1">
                      <kbd className="px-2 py-1 bg-slate-700 rounded text-xs border border-slate-600">→</kbd>
                  </div>
                  <span>Use arrows to sync delay during the song!</span>
               </div>
            </div>

            <button 
                onClick={startGame}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white font-bold py-4 rounded-xl text-xl flex items-center justify-center gap-3 transition-transform hover:scale-[1.02] shadow-lg shadow-green-900/20"
            >
                <Mic size={24} />
                START SINGING
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderPlaying = () => {
    if (!songData) return null;
    
    return (
      <div className="relative w-full h-[calc(100vh-80px)] flex flex-col overflow-hidden bg-black rounded-3xl border-4 border-slate-800 shadow-2xl animate-fade-in">
        
        {/* Top UI Overlay */}
        <div className="absolute top-0 left-0 right-0 z-20 p-4 flex justify-between items-start bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
           <div className="flex flex-col pointer-events-auto">
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

        {/* Sync Controls (Bottom Center) */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-4 bg-slate-900/80 backdrop-blur rounded-full px-4 py-2 border border-slate-700">
           <button 
             onClick={() => setAudioDelay(d => d - 0.05)}
             className="p-1 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"
           >
             <Minus size={16} />
           </button>
           <div className="flex flex-col items-center w-20">
             <span className="text-[10px] uppercase font-bold text-slate-500">Sync Offset</span>
             <span className={`text-xs font-mono font-bold ${audioDelay === 0 ? 'text-white' : 'text-blue-400'}`}>
                {audioDelay > 0 ? '+' : ''}{(audioDelay * 1000).toFixed(0)}ms
             </span>
           </div>
           <button 
             onClick={() => setAudioDelay(d => d + 0.05)}
             className="p-1 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"
           >
             <Plus size={16} />
           </button>
        </div>

        {/* Audience Meter Overlay (Left Center) */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
            <AudienceMeter mood={scoreState.audienceMood} combo={scoreState.combo} />
        </div>

        {/* Main Pitch Visualizer Layer (Middle) */}
        <div className="absolute inset-0 z-10 pointer-events-none">
           <PitchVisualizer 
              currentTime={effectiveTime}
              userPitch={userPitch}
              notes={songData.notes}
              scoreState={scoreState}
              isPlaying={status === GameStatus.PLAYING}
              difficultyMode={difficultyMode}
           />
        </div>

        {/* YouTube Video Background & Placeholder */}
        <div className="absolute inset-0 z-0 bg-black">
           {/* Fallback Image if video loads slowly or is just audio */}
           {(songData.backgroundUrl || songData.coverUrl) && (
              <div 
                 className="absolute inset-0 bg-cover bg-center opacity-40 z-0"
                 style={{ backgroundImage: `url(${songData.backgroundUrl || songData.coverUrl})` }}
              />
           )}
           
           {songData.videoId ? (
             <iframe 
              ref={iframeRef}
              width="100%" 
              height="100%" 
              src={`https://www.youtube.com/embed/${songData.videoId}?autoplay=1&controls=0&rel=0`}
              title="YouTube video player" 
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
              referrerPolicy="strict-origin-when-cross-origin"
              className="absolute inset-0 w-full h-full object-cover z-10 opacity-70 mix-blend-screen"
             />
           ) : (
             <div className="absolute inset-0 flex items-center justify-center z-10 opacity-70">
                <p className="text-slate-500 font-bold">No Video Available</p>
             </div>
           )}
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
  
  // --- Manual Paste Modal ---
  const renderPasteModal = () => (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-slate-800 rounded-2xl w-full max-w-2xl p-6 border border-slate-700 shadow-2xl flex flex-col gap-4">
              <div className="flex justify-between items-center">
                  <h3 className="text-xl font-bold text-white flex items-center gap-2">
                     <FileText size={24} className="text-blue-400"/> Paste UltraStar TXT
                  </h3>
                  <button onClick={() => setShowTxtPaste(false)} className="text-slate-400 hover:text-white">Close</button>
              </div>
              <p className="text-sm text-slate-400">
                  Paste the content of your .txt file here. We will extract the metadata, notes, and cover art automatically.
              </p>
              <textarea 
                className="w-full h-64 bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs font-mono text-slate-300 focus:border-blue-500 outline-none"
                placeholder={`#ARTIST: The Beatles\n#TITLE: Let It Be\n#VIDEO:v=QDYfEBY9NM4,co=https://cover.jpg\n: 10 4 60 When I find myself...`}
                value={manualTxt}
                onChange={(e) => setManualTxt(e.target.value)}
              />
              <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => setShowTxtPaste(false)}
                    className="px-4 py-2 text-slate-300 hover:text-white"
                  >
                      Cancel
                  </button>
                  <button 
                    onClick={handleManualPaste}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold"
                  >
                      Load Song
                  </button>
              </div>
          </div>
      </div>
  );

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex flex-col font-['Inter']">
      {/* Header */}
      <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-[#0f172a]/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer group" onClick={resetGame}>
          <div className="bg-gradient-to-br from-blue-500 to-purple-600 p-2 rounded-lg group-hover:scale-105 transition-transform">
            <Music2 size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400 hidden sm:block">
            KaraokeGenius
          </h1>
        </div>
        
        {status === GameStatus.IDLE && (
           <div className="flex items-center gap-4">
               <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800">
                   <button 
                     onClick={() => setSearchMode('USDB')}
                     className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${searchMode === 'USDB' ? 'bg-green-600 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}
                   >
                       Animux (USDB)
                   </button>
                   <button 
                     onClick={() => setSearchMode('AI')}
                     className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${searchMode === 'AI' ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}
                   >
                       AI Auto
                   </button>
               </div>
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
            <p className="text-slate-400 text-lg mb-8 max-w-xl">
              {searchMode === 'AI' 
                ? "Search for any song. AI generates the track instantly."
                : "Search the Animux database for community-created UltraStar charts."
              }
            </p>

            <div className="relative w-full max-w-xl group">
              <div className={`absolute -inset-1 bg-gradient-to-r ${searchMode === 'AI' ? 'from-blue-600 to-purple-600' : 'from-green-600 to-emerald-600'} rounded-2xl blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200`}></div>
              <div className="relative flex items-center bg-slate-900 border border-slate-700 rounded-xl p-2 shadow-2xl">
                <Search className="text-slate-400 ml-3" />
                <input 
                  type="text" 
                  className="bg-transparent border-none outline-none text-white text-lg w-full px-4 py-3 placeholder-slate-500"
                  placeholder={searchMode === 'AI' ? "Enter song name..." : "Search Animux database..."}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button 
                  onClick={handleSearch}
                  className={`${searchMode === 'AI' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-green-600 hover:bg-green-500'} text-white font-semibold px-6 py-3 rounded-lg transition-colors`}
                >
                  Search
                </button>
              </div>
            </div>
            
            {searchMode === 'USDB' && (
                <div className="mt-4">
                    <button onClick={() => setShowTxtPaste(true)} className="text-slate-500 hover:text-slate-300 text-sm underline">
                        Or paste .txt file directly
                    </button>
                </div>
            )}
            
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
                    <Database size={20} className={searchMode === 'USDB' ? "text-green-400" : "text-slate-600"} />
                  </div>
                  <span className="text-xs font-medium">{searchMode === 'USDB' ? 'Animux DB' : 'AI Mode'}</span>
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
        
        {showTxtPaste && renderPasteModal()}

      </main>
    </div>
  );
};

export default App;