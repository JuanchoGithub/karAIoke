import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Search, Music2, Play, Trophy, AlertCircle, Loader2, ArrowLeft, Youtube, Settings2, Plus, Minus, Database, FileText, Image as ImageIcon, Zap } from 'lucide-react';
import { SongData, GameStatus, ScoreState, SearchResult, Difficulty } from './types';
import { searchYoutubeSongs, generateSongChart } from './services/geminiService';
import { autoCorrelate, frequencyToMidi } from './services/audioAnalysis';
import { searchUsdb, fetchUsdbContent } from './services/usdbService';
import { parseUltraStarTxt } from './services/ultraStarParser';
import PitchVisualizer from './components/PitchVisualizer';
import AudienceMeter from './components/AudienceMeter';

// Declare YouTube API types
declare global {
  interface Window {
    onYouTubeIframeAPIReady: () => void;
    YT: any;
  }
}

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<GameStatus>(GameStatus.IDLE);
  const [searchMode, setSearchMode] = useState<'AI' | 'USDB'>('USDB'); 
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [songData, setSongData] = useState<SongData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMicReady, setIsMicReady] = useState(false);
  const [isVideoReady, setIsVideoReady] = useState(false); // New state for video player
  
  // Settings
  const [difficultyMode, setDifficultyMode] = useState<Difficulty>('Novice');
  
  // Manual TXT Paste State
  const [showTxtPaste, setShowTxtPaste] = useState(false);
  const [manualTxt, setManualTxt] = useState('');

  // Game Logic State (Refs for performance)
  const currentTimeRef = useRef(0);
  const userPitchRef = useRef(0);
  
  // Internal Score State (Real-time)
  const scoreLogicStateRef = useRef<ScoreState>({
    currentScore: 0,
    combo: 0,
    maxCombo: 0,
    perfectHits: 0,
    goodHits: 0,
    misses: 0,
    audienceMood: 50
  });

  // UI Score State (Throttled update)
  const [scoreDisplayState, setScoreDisplayState] = useState<ScoreState>(scoreLogicStateRef.current);

  const [audioDelay, setAudioDelay] = useState(0); 

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const microphoneRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Re-use buffer to prevent GC lag
  const audioBufferRef = useRef<Float32Array | null>(null);

  const requestRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);
  
  // YouTube Player Refs
  const playerRef = useRef<any>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);

  // --- Audio Handling (Microphone) ---
  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive',
        sampleRate: 48000 // Force consistent sample rate if possible
      });
      
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048; // Keeping good resolution
      analyserRef.current.smoothingTimeConstant = 0.2; // Lower latency
      
      microphoneRef.current = audioContextRef.current.createMediaStreamSource(stream);
      microphoneRef.current.connect(analyserRef.current);
      
      // Initialize buffer once
      audioBufferRef.current = new Float32Array(analyserRef.current.fftSize);

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
    audioBufferRef.current = null;
    setIsMicReady(false);
  };

  // --- YouTube Player Logic ---
  const loadYouTubeApi = useCallback(() => {
    if (window.YT && window.YT.Player) return; // Already loaded
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
  }, []);

  const initializePlayer = useCallback((videoId: string) => {
    setIsVideoReady(false);
    
    const onPlayerReady = (event: any) => {
      event.target.playVideo();
    };

    const onPlayerStateChange = (event: any) => {
      // YT.PlayerState.PLAYING = 1
      if (event.data === 1) {
        setIsVideoReady(true);
      }
      // YT.PlayerState.BUFFERING = 3
      if (event.data === 3) {
         // Optionally handle buffering visual
      }
    };

    if (window.YT && window.YT.Player) {
      playerRef.current = new window.YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: videoId,
        playerVars: {
          'autoplay': 1,
          'controls': 0,
          'rel': 0,
          'showinfo': 0,
          'modestbranding': 1,
          'playsinline': 1,
          'disablekb': 1,
          'fs': 0,
          'iv_load_policy': 3
        },
        events: {
          'onReady': onPlayerReady,
          'onStateChange': onPlayerStateChange
        }
      });
    }
  }, []);

  // --- Game Loop ---
  // Optimized to NOT cause re-renders
  const updateGame = useCallback(() => {
    if (status !== GameStatus.PLAYING || !songData) return;

    // 1. Update Time
    // SYNC FIX: Trust the video player time instead of Date.now()
    // This handles buffering automatically.
    let currentTime = 0;
    if (playerRef.current && playerRef.current.getCurrentTime) {
        const videoTime = playerRef.current.getCurrentTime();
        // Fallback if videoTime is 0 or invalid initially
        if (typeof videoTime === 'number') {
            currentTime = videoTime;
        }
    }
    
    // Apply user manual offset
    const calculatedTime = currentTime + audioDelay;
    
    // Update Ref (No render)
    currentTimeRef.current = calculatedTime;

    // 2. Update Pitch
    if (analyserRef.current && audioContextRef.current) {
        // PERFORMANCE: Re-use the existing Float32Array
        if (!audioBufferRef.current) {
             audioBufferRef.current = new Float32Array(analyserRef.current.fftSize);
        }
        const buffer = audioBufferRef.current;
        analyserRef.current.getFloatTimeDomainData(buffer);
        
        // Optimized autoCorrelate is called here
        const freq = autoCorrelate(buffer, audioContextRef.current.sampleRate);
        
        if (freq > 70 && freq < 1400) {
           userPitchRef.current = freq;
        } else {
           userPitchRef.current = 0;
        }
    }

    // 3. Scoring Logic
    // Only score if the video is actually running/ready
    if (isVideoReady) {
        const userPitch = userPitchRef.current;
        const userMidi = frequencyToMidi(userPitch);
        const activeNote = songData.notes.find(n => calculatedTime >= n.startTime && calculatedTime <= n.startTime + n.duration);
        
        const s = scoreLogicStateRef.current;

        if (activeNote) {
        if (userPitch > 0) {
            let diff = Math.abs(userMidi - activeNote.pitch);

            // Novice Mode Tolerance
            if (difficultyMode === 'Novice') {
                const diffOctaveDown = Math.abs((userMidi + 12) - activeNote.pitch);
                const diffOctaveUp = Math.abs((userMidi - 12) - activeNote.pitch);
                const diffOctaveDown2 = Math.abs((userMidi + 24) - activeNote.pitch);
                const diffOctaveUp2 = Math.abs((userMidi - 24) - activeNote.pitch);
                diff = Math.min(diff, diffOctaveDown, diffOctaveUp, diffOctaveDown2, diffOctaveUp2);
            }
            
            if (diff < 1.5) {
                s.currentScore += 10 + (s.combo * 2);
                s.combo += 1;
                s.perfectHits += 1;
                s.audienceMood = Math.min(100, s.audienceMood + 0.5);
            } else if (diff < 3.0) {
                s.currentScore += 5;
                s.combo += 1;
                s.goodHits += 1;
                s.audienceMood = Math.min(100, s.audienceMood + 0.1);
            } else {
                s.combo = 0;
                s.misses += 1;
                s.audienceMood = Math.max(0, s.audienceMood - 0.2);
            }
        } else {
            s.audienceMood = Math.max(0, s.audienceMood - 0.05);
        }
        }
        s.maxCombo = Math.max(s.maxCombo, s.combo);
    }

    // 4. Update UI Throttle
    // Only trigger React State update every 10 frames (approx 6 times a second)
    frameCountRef.current += 1;
    if (frameCountRef.current % 10 === 0) {
        setScoreDisplayState({ ...scoreLogicStateRef.current });
    }

    requestRef.current = requestAnimationFrame(updateGame);
  }, [status, songData, audioDelay, difficultyMode, isVideoReady]);

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

  // Init YouTube API on mount
  useEffect(() => {
    window.onYouTubeIframeAPIReady = () => {
       console.log("YouTube API Ready");
    };
    loadYouTubeApi();
  }, [loadYouTubeApi]);

  // When entering PLAYING state, init player
  useEffect(() => {
    if (status === GameStatus.PLAYING && songData?.videoId) {
        // Small timeout to ensure DOM element exists
        setTimeout(() => {
             initializePlayer(songData.videoId);
        }, 100);
    }
    return () => {
        if (playerRef.current && playerRef.current.destroy) {
            try {
                playerRef.current.destroy();
            } catch(e) { /* ignore */ }
            playerRef.current = null;
        }
        setIsVideoReady(false);
    };
  }, [status, songData, initializePlayer]);

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
         if (!song.id) throw new Error("Invalid USDB ID");
         const { txt, extraVideoId, extraCoverUrl } = await fetchUsdbContent(song.id);
         if (!txt) {
             throw new Error("Could not fetch song data. USDB entry might be private.");
         }
         const parsedData = parseUltraStarTxt(txt);
         if (!parsedData.videoId && extraVideoId) parsedData.videoId = extraVideoId;
         if (!parsedData.coverUrl && extraCoverUrl) parsedData.coverUrl = extraCoverUrl;

         if (!parsedData.videoId) {
             console.log("No video ID in TXT or USDB Page, searching YouTube...");
             const ytResults = await searchYoutubeSongs(`${parsedData.artist} ${parsedData.title} karaoke`);
             if (ytResults.length > 0) {
                 parsedData.videoId = ytResults[0].videoId;
             }
         }
         setSongData(parsedData);
      } else {
         const data = await generateSongChart(song);
         setSongData(data);
      }
    } catch (err) {
      console.error(err);
      setError("Failed to load song. " + (err instanceof Error ? err.message : ""));
      if (searchMode === 'USDB') setShowTxtPaste(true);
      setStatus(GameStatus.SELECTING);
    }
  };
  
  const handleManualPaste = async () => {
      if (!manualTxt.trim()) return;
      try {
          const parsedData = parseUltraStarTxt(manualTxt);
          if (!parsedData.videoId) {
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

    currentTimeRef.current = 0;
    userPitchRef.current = 0;
    frameCountRef.current = 0;
    
    // Reset Score logic
    scoreLogicStateRef.current = {
      currentScore: 0,
      combo: 0,
      maxCombo: 0,
      perfectHits: 0,
      goodHits: 0,
      misses: 0,
      audienceMood: 50
    };
    setScoreDisplayState(scoreLogicStateRef.current);
    
    setAudioDelay(0);
    setStatus(GameStatus.PLAYING);
  };

  const resetGame = () => {
    setStatus(GameStatus.IDLE);
    stopMicrophone();
    setSongData(null);
    setSearchQuery('');
    setSearchResults([]);
    setShowTxtPaste(false);
    setManualTxt('');
    setIsVideoReady(false);
  };

  const goBackToSearch = () => {
    setStatus(GameStatus.IDLE);
    setSearchResults([]);
  };

  // --- Render Functions ---

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
        <button onClick={goBackToSearch} className="p-2 hover:bg-slate-800 rounded-full transition-colors">
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
            <div className="relative aspect-video w-full overflow-hidden bg-slate-900 flex items-center justify-center">
               {result.videoId ? (
                   <img src={`https://img.youtube.com/vi/${result.videoId}/mqdefault.jpg`} alt={result.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"/>
               ) : (
                   <div className="flex flex-col items-center justify-center gap-2">
                       <Database size={48} className="text-slate-600 group-hover:text-green-500 transition-colors" />
                       <span className="text-xs text-slate-500 uppercase font-bold tracking-widest">Click to Load</span>
                   </div>
               )}
               <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                 {result.source === 'USDB' ? <><FileText size={12} className="text-green-500" />USDB</> : <><Youtube size={12} className="text-red-500" />Karaoke</>}
               </div>
            </div>
            <div className="p-4">
              <h3 className="font-bold text-white mb-1 line-clamp-2 leading-tight group-hover:text-blue-400 transition-colors">{result.title}</h3>
              <p className="text-slate-400 text-sm mb-2">{result.artist}</p>
            </div>
          </div>
        ))}
      </div>
      {searchMode === 'USDB' && (
          <div className="w-full flex justify-center mt-8">
              <button onClick={() => setShowTxtPaste(true)} className="text-slate-400 hover:text-white underline text-sm">
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
            </div>
        );
    }
    return (
      <div className="flex flex-col items-center gap-6 max-w-2xl w-full animate-fade-in relative z-10">
        <div className="w-full flex justify-start">
             <button onClick={() => setStatus(GameStatus.IDLE)} className="text-slate-400 hover:text-white flex items-center gap-2 mb-2"><ArrowLeft size={20} /> Back to Search</button>
        </div>
        <div className="bg-slate-800 p-6 rounded-2xl w-full border border-slate-700 shadow-2xl overflow-hidden relative">
          {songData.coverUrl && (
              <div className="absolute inset-0 z-0 opacity-20 pointer-events-none blur-xl" style={{ backgroundImage: `url(${songData.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
          )}
          <div className="relative z-10">
            <div className="flex gap-4 items-start mb-6">
                {songData.coverUrl ? <img src={songData.coverUrl} alt="Cover" className="w-24 h-24 rounded-lg shadow-lg object-cover border border-white/10" /> : <div className="w-24 h-24 rounded-lg bg-slate-700 flex items-center justify-center shadow-lg border border-white/10"><Music2 size={32} className="text-slate-500" /></div>}
                <div>
                    <h2 className="text-3xl font-bold text-white mb-2 leading-tight">{songData.title}</h2>
                    <p className="text-lg text-blue-400">{songData.artist}</p>
                    {songData.sourceType === 'USDB' && <span className="bg-green-900/80 text-green-400 border border-green-500/50 text-xs px-2 py-1 rounded font-mono mt-2 inline-block">USDB SOURCE</span>}
                </div>
            </div>
            <div className="bg-slate-900/60 rounded-xl p-4 mb-4 border border-white/5">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2"><Zap size={16} className={difficultyMode === 'Novice' ? 'text-green-400' : 'text-purple-400'}/> Difficulty Mode</span>
                </div>
                <div className="flex bg-slate-800 p-1 rounded-lg">
                    <button onClick={() => setDifficultyMode('Novice')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${difficultyMode === 'Novice' ? 'bg-green-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>Novice</button>
                    <button onClick={() => setDifficultyMode('Pro')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${difficultyMode === 'Pro' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>Pro</button>
                </div>
            </div>
            <button onClick={startGame} className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white font-bold py-4 rounded-xl text-xl flex items-center justify-center gap-3 transition-transform hover:scale-[1.02] shadow-lg shadow-green-900/20">
                <Mic size={24} /> START SINGING
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
                {Math.floor(scoreDisplayState.currentScore).toLocaleString()}
              </span>
              <span className="text-xs font-bold text-slate-400 uppercase">Score</span>
           </div>
        </div>

        {/* Sync Controls */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-4 bg-slate-900/80 backdrop-blur rounded-full px-4 py-2 border border-slate-700 pointer-events-auto">
           <button onClick={() => setAudioDelay(d => d - 0.05)} className="p-1 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"><Minus size={16} /></button>
           <div className="flex flex-col items-center w-24 cursor-help" title="If lyrics are ahead, press -. If lyrics are behind, press +">
             <span className="text-[10px] uppercase font-bold text-slate-500">Video Offset</span>
             <span className={`text-xs font-mono font-bold ${audioDelay === 0 ? 'text-white' : 'text-blue-400'}`}>{audioDelay > 0 ? '+' : ''}{(audioDelay * 1000).toFixed(0)}ms</span>
           </div>
           <button onClick={() => setAudioDelay(d => d + 0.05)} className="p-1 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"><Plus size={16} /></button>
        </div>

        {/* Audience Meter */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 pointer-events-none">
            <AudienceMeter mood={scoreDisplayState.audienceMood} combo={scoreDisplayState.combo} />
        </div>

        {/* Pitch Visualizer: uses Refs now! */}
        <div className="absolute inset-0 z-10 pointer-events-none">
           <PitchVisualizer 
              currentTimeRef={currentTimeRef}
              userPitchRef={userPitchRef}
              notes={songData.notes}
              isPlaying={status === GameStatus.PLAYING}
              difficultyMode={difficultyMode}
           />
        </div>

        {/* Loading / Waiting for Video Overlay */}
        {!isVideoReady && (
            <div className="absolute inset-0 z-40 bg-black/90 flex flex-col items-center justify-center gap-4">
                <Loader2 size={48} className="text-blue-500 animate-spin" />
                <p className="text-white font-bold text-xl">Loading Video...</p>
            </div>
        )}

        {/* Video Background - Uses Iframe API div */}
        <div className="absolute inset-0 z-0 bg-black">
           {(songData.backgroundUrl || songData.coverUrl) && !isVideoReady && (
              <div className="absolute inset-0 bg-cover bg-center opacity-40 z-0" style={{ backgroundImage: `url(${songData.backgroundUrl || songData.coverUrl})` }} />
           )}
           <div 
             id="youtube-player" 
             className="absolute inset-0 w-full h-full object-cover z-10 opacity-70 mix-blend-screen"
             ref={playerContainerRef}
           />
        </div>

        <button onClick={resetGame} className="absolute bottom-6 right-6 z-30 bg-red-600/80 hover:bg-red-500 p-3 rounded-full text-white backdrop-blur-sm transition-all pointer-events-auto">
          <div className="w-4 h-4 bg-white rounded-sm" />
        </button>
      </div>
    );
  };
  
  const renderPasteModal = () => (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-slate-800 rounded-2xl w-full max-w-2xl p-6 border border-slate-700 shadow-2xl flex flex-col gap-4">
              <div className="flex justify-between items-center">
                  <h3 className="text-xl font-bold text-white flex items-center gap-2"><FileText size={24} className="text-blue-400"/> Paste UltraStar TXT</h3>
                  <button onClick={() => setShowTxtPaste(false)} className="text-slate-400 hover:text-white">Close</button>
              </div>
              <textarea className="w-full h-64 bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs font-mono text-slate-300 focus:border-blue-500 outline-none" value={manualTxt} onChange={(e) => setManualTxt(e.target.value)} />
              <div className="flex justify-end gap-3">
                  <button onClick={() => setShowTxtPaste(false)} className="px-4 py-2 text-slate-300 hover:text-white">Cancel</button>
                  <button onClick={handleManualPaste} className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold">Load Song</button>
              </div>
          </div>
      </div>
  );

  return (
    <div className="min-h-screen bg-[#0f172a] text-white flex flex-col font-['Inter']">
      <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-[#0f172a]/90 backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer group" onClick={resetGame}>
          <div className="bg-gradient-to-br from-blue-500 to-purple-600 p-2 rounded-lg group-hover:scale-105 transition-transform"><Music2 size={24} className="text-white" /></div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400 hidden sm:block">KaraokeGenius</h1>
        </div>
        {status === GameStatus.IDLE && (
           <div className="flex items-center gap-4">
               <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800">
                   <button onClick={() => setSearchMode('USDB')} className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${searchMode === 'USDB' ? 'bg-green-600 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}>Animux (USDB)</button>
                   <button onClick={() => setSearchMode('AI')} className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${searchMode === 'AI' ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}>AI Auto</button>
               </div>
           </div>
        )}
      </header>

      <main className="flex-1 flex flex-col items-center justify-start p-6 overflow-hidden">
        {status === GameStatus.IDLE && (
          <div className="w-full max-w-3xl flex flex-col items-center mt-20 text-center animate-fade-in">
            <h2 className="text-5xl font-black mb-6 text-white tracking-tight">Sing Like a <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">Star</span></h2>
            <p className="text-slate-400 text-lg mb-8 max-w-xl">{searchMode === 'AI' ? "Search for any song. AI generates the track instantly." : "Search the Animux database for community-created UltraStar charts."}</p>
            <div className="relative w-full max-w-xl group">
              <div className={`absolute -inset-1 bg-gradient-to-r ${searchMode === 'AI' ? 'from-blue-600 to-purple-600' : 'from-green-600 to-emerald-600'} rounded-2xl blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200`}></div>
              <div className="relative flex items-center bg-slate-900 border border-slate-700 rounded-xl p-2 shadow-2xl">
                <Search className="text-slate-400 ml-3" />
                <input type="text" className="bg-transparent border-none outline-none text-white text-lg w-full px-4 py-3 placeholder-slate-500" placeholder={searchMode === 'AI' ? "Enter song name..." : "Search Animux database..."} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSearch()} />
                <button onClick={handleSearch} className={`${searchMode === 'AI' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-green-600 hover:bg-green-500'} text-white font-semibold px-6 py-3 rounded-lg transition-colors`}>Search</button>
              </div>
            </div>
            {searchMode === 'USDB' && <div className="mt-4"><button onClick={() => setShowTxtPaste(true)} className="text-slate-500 hover:text-slate-300 text-sm underline">Or paste .txt file directly</button></div>}
            <div className="mt-12 flex gap-8 text-slate-500">
               <div className="flex flex-col items-center gap-2"><div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700"><Mic size={20} className="text-blue-400" /></div><span className="text-xs font-medium">Pitch Detection</span></div>
               <div className="flex flex-col items-center gap-2"><div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700"><Trophy size={20} className="text-yellow-400" /></div><span className="text-xs font-medium">Live Scoring</span></div>
               <div className="flex flex-col items-center gap-2"><div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700"><Database size={20} className={searchMode === 'USDB' ? "text-green-400" : "text-slate-600"} /></div><span className="text-xs font-medium">{searchMode === 'USDB' ? 'Animux DB' : 'AI Mode'}</span></div>
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