import React, { useEffect, useRef, useMemo } from 'react';
import { Note, Difficulty } from '../types';
import { midiToNoteName } from '../services/audioAnalysis';

interface PitchVisualizerProps {
  currentTimeRef: React.MutableRefObject<number>;
  userPitchRef: React.MutableRefObject<number>;
  notes: Note[];
  isPlaying: boolean;
  difficultyMode: Difficulty;
}

const PitchVisualizer: React.FC<PitchVisualizerProps> = React.memo(({
  currentTimeRef,
  userPitchRef,
  notes,
  isPlaying,
  difficultyMode
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<{x: number, y: number, life: number, color: string}[]>([]);

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
    // CRITICAL FIX: alpha: true allows the video background to show through the canvas
    const ctx = canvas.getContext('2d', { alpha: true }); 
    if (!ctx) return;

    let animationId: number;

    const render = () => {
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
        if (ctx.roundRect) {
            ctx.roundRect(x, y, w, NOTE_HEIGHT, 4);
        } else {
            ctx.rect(x, y, w, NOTE_HEIGHT);
        }
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
                const diffDown2 = Math.abs((userMidi + 24) - closestNote.pitch); 
                const diffUp2 = Math.abs((userMidi - 24) - closestNote.pitch);

                if (diffDown < 2.0) { userMidi += 12; isHitting = true; }
                else if (diffUp < 2.0) { userMidi -= 12; isHitting = true; }
                else if (diffDown2 < 2.0) { userMidi += 24; isHitting = true; }
                else if (diffUp2 < 2.0) { userMidi -= 24; isHitting = true; }
            }
        }
        
        const y = getY(userMidi);
        const x = hitLineX;

        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = isHitting ? '#22c55e' : '#ef4444'; 
        ctx.fill();
        
        // PERFORMANCE FIX: Removed shadowBlur. It causes massive lag on many devices.
        // ctx.shadowBlur = 10;
        
        if (isHitting && Math.random() > 0.5) {
            particlesRef.current.push({ x, y, life: 1.0, color: '#22c55e' });
        }
      }

      // Draw Particles
      if (particlesRef.current.length > 0) {
        for (let i = particlesRef.current.length - 1; i >= 0; i--) {
            const p = particlesRef.current[i];
            p.life -= 0.05;
            p.x -= 3;
            p.y += (Math.random() - 0.5) * 4;
            
            if (p.life <= 0) {
                particlesRef.current.splice(i, 1);
                continue;
            }

            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;
      }

      if (isPlaying) {
        animationId = requestAnimationFrame(render);
      }
    };

    if (isPlaying) {
        render();
    }

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [notes, isPlaying, difficultyMode, minPitch, maxPitch, PITCH_RANGE]); 

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-full block"
      style={{ touchAction: 'none' }}
    />
  );
});

export default PitchVisualizer;