import React, { useEffect, useRef, useMemo } from 'react';
import { Note, Difficulty } from '../types';
import { midiToNoteName } from '../services/audioAnalysis';

interface PitchVisualizerProps {
  currentTimeRef: React.MutableRefObject<number>;
  userPitchRef: React.MutableRefObject<number>;
  notes: Note[];
  isPlaying: boolean;
  difficultyMode: Difficulty;
  processingTimeMs?: number; // New prop for profiling
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
    
    // Ensure minimum range (at least 1.5 octaves = 18 semitones) to avoid extreme zoom on monotonic songs
    if (max - min < 18) {
        const center = (max + min) / 2;
        min = center - 9;
        max = center + 9;
    }

    return { minPitch: min, maxPitch: max };
  }, [notes]);

  const PITCH_RANGE = maxPitch - minPitch;
  const VISIBLE_WINDOW = 4; // seconds visible on screen
  const NOTE_HEIGHT = 12;

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

      // Optimization: Access clientWidth/Height which causes less layout thrashing than getBoundingClientRect
      const dpr = window.devicePixelRatio || 1;
      const displayWidth = canvas.clientWidth;
      const displayHeight = canvas.clientHeight;
      
      const targetWidth = Math.floor(displayWidth * dpr);
      const targetHeight = Math.floor(displayHeight * dpr);

      // Only resize buffer if dimensions change
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        // Reset transform if not resizing, to ensure scale is correct for this frame
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

      // Clear the canvas to be transparent
      ctx.clearRect(0, 0, width, height);

      // Draw Background Grid (Pitch Lines)
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.5)'; // Transparent slate
      ctx.lineWidth = 1;
      
      const startPitch = Math.floor(minPitch);
      const endPitch = Math.ceil(maxPitch);

      // Batch drawing lines
      ctx.beginPath();
      for (let i = startPitch; i <= endPitch; i++) {
        const y = getY(i);
        const isC = i % 12 === 0;
        
        if (PITCH_RANGE < 30 || isC || i % 12 === 5) {
             ctx.moveTo(0, y);
             ctx.lineTo(width, y);
        }
      }
      ctx.stroke();

      // Highlight Octaves
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)';
      ctx.lineWidth = 2;
      for (let i = startPitch; i <= endPitch; i++) {
         if (i % 12 === 0) {
            const y = getY(i);
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            // Draw Label
            ctx.fillStyle = '#94a3b8';
            ctx.font = '10px Inter';
            ctx.fillText(midiToNoteName(i), 5, y - 2);
         }
      }
      ctx.stroke();

      // Draw "Hit Line"
      const hitLineX = width * 0.2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hitLineX, 0);
      ctx.lineTo(hitLineX, height);
      ctx.stroke();

      // Find active notes
      let activeNotes: Note[] = [];

      notes.forEach(note => {
        // Culling
        if (note.startTime + note.duration < currentTime - 1 || note.startTime > currentTime + VISIBLE_WINDOW) {
          return;
        }

        if (currentTime >= note.startTime && currentTime <= note.startTime + note.duration) {
            activeNotes.push(note);
        }

        const x = getX(note.startTime);
        const w = (note.duration * (width / VISIBLE_WINDOW));
        const y = getY(note.pitch);
        
        const isActive = currentTime >= note.startTime && currentTime <= note.startTime + note.duration;
        
        ctx.fillStyle = isActive ? '#3b82f6' : '#64748b';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        
        ctx.beginPath();
        ctx.rect(x, y, w, NOTE_HEIGHT); // Use simple rect for performance
        ctx.fill();
        ctx.stroke();

        if (note.lyric) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Inter';
            ctx.fillText(note.lyric, x, y - 8);
        }
      });

      // Draw User Pitch Indicator
      if (userPitch > 0) {
        let userMidi = 12 * Math.log2(userPitch / 440) + 69;
        let isHitting = false;
        
        if (activeNotes.length > 0) {
            let closestNote = activeNotes[0];
            let minDiff = Infinity;
            
            // Just find closest active note (simplified for visual)
            activeNotes.forEach(note => {
               const diff = Math.abs(userMidi - note.pitch);
               if (diff < minDiff) {
                 minDiff = diff;
                 closestNote = note;
               }
            });

            if (minDiff < 2.0) {
                isHitting = true;
            } else if (difficultyMode === 'Novice') {
                const diffDown = Math.abs((userMidi + 12) - closestNote.pitch);
                const diffUp = Math.abs((userMidi - 12) - closestNote.pitch);
                if (diffDown < 2.0) { userMidi += 12; isHitting = true; }
                else if (diffUp < 2.0) { userMidi -= 12; isHitting = true; }
            }
        }
        
        const y = getY(userMidi);
        const x = hitLineX;

        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        
        // Simple glow effect using color change instead of expensive shadowBlur
        ctx.fillStyle = isHitting ? '#22c55e' : '#ef4444'; 
        ctx.fill();
        
        // Ring for hit confirmation
        if (isHitting) {
            ctx.strokeStyle = '#86efac';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
      }

      // Draw FPS & Profiler
      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.fillRect(0, 0, 180, 40);
      
      ctx.fillStyle = fpsRef.current < 30 ? '#ef4444' : '#22c55e';
      ctx.font = '10px monospace';
      ctx.fillText(`FPS: ${Math.round(fpsRef.current)}`, 5, 14);
      
      ctx.fillStyle = processingTimeMs > 4 ? '#ef4444' : '#94a3b8';
      ctx.fillText(`CPU: ${processingTimeMs.toFixed(2)}ms`, 60, 14);

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Time: ${currentTime.toFixed(2)}s`, 5, 28);


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