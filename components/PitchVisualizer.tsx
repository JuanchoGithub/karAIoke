import React, { useEffect, useRef, useMemo } from 'react';
import { Note, Difficulty } from '../types';
import { midiToNoteName } from '../services/audioAnalysis';

interface PitchVisualizerProps {
  currentTimeRef: React.MutableRefObject<number>;
  userPitchRef: React.MutableRefObject<number>;
  notes: Note[];
  isPlaying: boolean;
  difficultyMode: Difficulty;
  processingTimeMs?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

interface PitchPoint {
  time: number;
  midi: number;
  isHitting: boolean;
}

const PitchVisualizer: React.FC<PitchVisualizerProps> = React.memo(({
  currentTimeRef,
  userPitchRef,
  notes,
  isPlaying,
  difficultyMode,
  processingTimeMs = 0
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Profiling Refs
  const fpsRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  
  // Visual Effect Refs
  const particlesRef = useRef<Particle[]>([]);
  const pitchHistoryRef = useRef<PitchPoint[]>([]);

  // Calculate Dynamic Pitch Range
  const { minPitch, maxPitch } = useMemo(() => {
    if (notes.length === 0) return { minPitch: 45, maxPitch: 84 };
    
    let min = Infinity;
    let max = -Infinity;
    
    notes.forEach(n => {
        if (n.pitch < min) min = n.pitch;
        if (n.pitch > max) max = n.pitch;
    });

    // Add padding (4 semitones on each side)
    min -= 4;
    max += 4;
    
    // Ensure minimum range (at least 1.5 octaves = 18 semitones)
    if (max - min < 18) {
        const center = (max + min) / 2;
        min = center - 9;
        max = center + 9;
    }

    return { minPitch: min, maxPitch: max };
  }, [notes]);

  const PITCH_RANGE = maxPitch - minPitch;
  const VISIBLE_WINDOW = 4; // seconds visible on screen
  const NOTE_HEIGHT = 16;   // Slightly thicker notes

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true }); 
    if (!ctx) return;

    let animationId: number;

    const render = (now: number) => {
      // FPS Calculation
      if (lastFrameTimeRef.current !== 0) {
        const delta = now - lastFrameTimeRef.current;
        fpsRef.current = 1000 / delta;
      }
      lastFrameTimeRef.current = now;

      const currentTime = currentTimeRef.current;
      const userPitch = userPitchRef.current;

      // Handle Resize
      const dpr = window.devicePixelRatio || 1;
      const displayWidth = canvas.clientWidth;
      const displayHeight = canvas.clientHeight;
      const targetWidth = Math.floor(displayWidth * dpr);
      const targetHeight = Math.floor(displayHeight * dpr);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const width = displayWidth;
      const height = displayHeight;

      const getY = (midiPitch: number) => {
        const normalized = (midiPitch - minPitch) / PITCH_RANGE;
        return height - (normalized * height) - (NOTE_HEIGHT / 2);
      };

      const getX = (time: number) => {
        const hitLineX = width * 0.2;
        const timeDiff = time - currentTime;
        const pixelsPerSecond = width / VISIBLE_WINDOW; 
        return hitLineX + (timeDiff * pixelsPerSecond);
      };

      // Clear Canvas
      ctx.clearRect(0, 0, width, height);

      // --- 1. Background Grid ---
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const startPitch = Math.floor(minPitch);
      const endPitch = Math.ceil(maxPitch);
      for (let i = startPitch; i <= endPitch; i++) {
        const y = getY(i);
        const isC = i % 12 === 0;
        
        if (PITCH_RANGE < 30 || isC || i % 12 === 5) {
             ctx.moveTo(0, y);
             ctx.lineTo(width, y);
        }
      }
      ctx.stroke();

      // Note Labels (Octaves)
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.6)';
      ctx.lineWidth = 2;
      for (let i = startPitch; i <= endPitch; i++) {
         if (i % 12 === 0) {
            const y = getY(i);
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
            ctx.font = '10px Inter';
            ctx.fillText(midiToNoteName(i), 5, y - 2);
         }
      }
      ctx.stroke();

      // --- 2. Hit Line ---
      const hitLineX = width * 0.2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hitLineX, 0);
      ctx.lineTo(hitLineX, height);
      ctx.stroke();

      // --- 3. Draw Notes ---
      let activeNotes: Note[] = [];

      notes.forEach(note => {
        // Culling
        if (note.startTime + note.duration < currentTime - 1 || note.startTime > currentTime + VISIBLE_WINDOW) {
          return;
        }

        const isActive = currentTime >= note.startTime && currentTime <= note.startTime + note.duration;
        if (isActive) activeNotes.push(note);

        const x = getX(note.startTime);
        const w = (note.duration * (width / VISIBLE_WINDOW));
        const y = getY(note.pitch);
        
        // Draw Note Bar
        ctx.fillStyle = isActive ? '#3b82f6' : '#475569';
        
        // Glow effect for active notes
        if (isActive) {
            ctx.shadowColor = '#60a5fa';
            ctx.shadowBlur = 15;
        } else {
            ctx.shadowBlur = 0;
        }

        // Rounded rect look
        ctx.beginPath();
        ctx.roundRect(x, y, Math.max(w, 4), NOTE_HEIGHT, 4);
        ctx.fill();
        ctx.shadowBlur = 0; // reset

        // Lyrics
        if (note.lyric) {
            ctx.fillStyle = isActive ? '#fff' : '#cbd5e1';
            ctx.font = isActive ? 'bold 14px Inter' : 'bold 12px Inter';
            const textWidth = ctx.measureText(note.lyric).width;
            // Center lyric if note is small, or left align if long
            const textX = w > textWidth ? x + (w - textWidth) / 2 : x;
            ctx.fillText(note.lyric, textX, y - 8);
        }
      });

      // --- 4. User Pitch Processing & History ---
      let userMidi = 0;
      let isHitting = false;

      if (userPitch > 0) {
         userMidi = 12 * Math.log2(userPitch / 440) + 69;
         
         // Determine hit status for color/particles
         if (activeNotes.length > 0) {
            // Find closest active note
            let minDiff = Infinity;
            let closestNote = activeNotes[0];
            activeNotes.forEach(note => {
               const diff = Math.abs(userMidi - note.pitch);
               if (diff < minDiff) { minDiff = diff; closestNote = note; }
            });

            // Tolerance check
            if (minDiff < 1.5) {
                isHitting = true;
            } else if (difficultyMode === 'Novice') {
                // Check octaves
                const diffDown = Math.abs((userMidi + 12) - closestNote.pitch);
                const diffUp = Math.abs((userMidi - 12) - closestNote.pitch);
                if (diffDown < 1.5) { userMidi += 12; isHitting = true; }
                else if (diffUp < 1.5) { userMidi -= 12; isHitting = true; }
            }
         }

         // Add to History
         pitchHistoryRef.current.push({
             time: currentTime,
             midi: userMidi,
             isHitting
         });
      }

      // Prune History (Keep last 2 seconds)
      const cutoffTime = currentTime - 2.0;
      while(pitchHistoryRef.current.length > 0 && pitchHistoryRef.current[0].time < cutoffTime) {
          pitchHistoryRef.current.shift();
      }

      // --- 5. Draw Pitch Trail ---
      if (pitchHistoryRef.current.length > 1) {
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          
          for (let i = 1; i < pitchHistoryRef.current.length; i++) {
              const p1 = pitchHistoryRef.current[i-1];
              const p2 = pitchHistoryRef.current[i];
              
              // Don't connect large time gaps
              if (p2.time - p1.time > 0.1) continue;

              const x1 = getX(p1.time);
              const y1 = getY(p1.midi);
              const x2 = getX(p2.time);
              const y2 = getY(p2.midi);

              ctx.beginPath();
              ctx.strokeStyle = p2.isHitting ? 'rgba(74, 222, 128, 0.8)' : 'rgba(148, 163, 184, 0.5)';
              ctx.moveTo(x1, y1 + NOTE_HEIGHT/2); // Center of note height
              ctx.lineTo(x2, y2 + NOTE_HEIGHT/2);
              ctx.stroke();
          }
      }

      // --- 6. Particles (Sparkles) ---
      // Update & Draw
      particlesRef.current.forEach(p => {
          p.x += p.vx;
          p.y += p.vy;
          p.life -= 0.04; // Fade out speed
          
          if (p.life > 0) {
              ctx.globalAlpha = p.life;
              ctx.fillStyle = p.color;
              ctx.beginPath();
              ctx.arc(p.x, p.y, 2 + (p.life * 2), 0, Math.PI * 2);
              ctx.fill();
          }
      });
      // Remove dead particles
      particlesRef.current = particlesRef.current.filter(p => p.life > 0);
      ctx.globalAlpha = 1.0;


      // --- 7. Draw Current Pitch Cursor ---
      if (userPitch > 0) {
        const y = getY(userMidi) + NOTE_HEIGHT/2;
        const x = hitLineX;

        // Spawn Particles if hitting
        if (isHitting && Math.random() < 0.3) { // Limit spawn rate
             particlesRef.current.push({
                 x: x,
                 y: y,
                 vx: (Math.random() - 0.5) * 6,
                 vy: (Math.random() - 0.5) * 6,
                 life: 1.0,
                 color: '#4ade80' // Green sparks
             });
        }

        // Glow Effect
        ctx.shadowBlur = 15;
        ctx.shadowColor = isHitting ? '#4ade80' : '#ef4444';
        
        ctx.beginPath();
        ctx.fillStyle = isHitting ? '#22c55e' : '#ef4444';
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner white core
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }


      // --- Debug UI ---
      ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
      ctx.roundRect(0, 0, 160, 40, 8);
      ctx.fill();
      
      ctx.fillStyle = fpsRef.current < 45 ? '#f87171' : '#4ade80';
      ctx.font = '10px monospace';
      ctx.fillText(`FPS: ${Math.round(fpsRef.current)}`, 10, 15);
      
      ctx.fillStyle = processingTimeMs > 8 ? '#f87171' : '#94a3b8';
      ctx.fillText(`Audio CPU: ${processingTimeMs.toFixed(2)}ms`, 10, 28);
      
      if (isPlaying) {
        animationId = requestAnimationFrame(render);
      }
    };

    if (isPlaying) {
        requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [notes, isPlaying, difficultyMode, minPitch, maxPitch, PITCH_RANGE, processingTimeMs]); 

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-full block"
      style={{ touchAction: 'none' }}
    />
  );
});

export default PitchVisualizer;