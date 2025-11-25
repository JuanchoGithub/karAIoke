import React, { useEffect, useRef, useMemo } from 'react';
import { Note, ScoreState, Difficulty } from '../types';
import { midiToNoteName } from '../services/audioAnalysis';

interface PitchVisualizerProps {
  currentTime: number;
  userPitch: number; // in Hz
  notes: Note[];
  scoreState: ScoreState;
  isPlaying: boolean;
  difficultyMode: Difficulty;
}

const PitchVisualizer: React.FC<PitchVisualizerProps> = ({
  currentTime,
  userPitch,
  notes,
  scoreState,
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

  // Helper to map pitch to Y coordinate (inverted because canvas Y=0 is top)
  const getY = (midiPitch: number, height: number) => {
    const normalized = (midiPitch - minPitch) / PITCH_RANGE;
    // Clamp to keep strictly within bounds for calculation, though drawing might overflow slightly
    // but canvas handles off-screen draw fine.
    return height - (normalized * height) - (NOTE_HEIGHT / 2);
  };

  // Helper to map time to X coordinate
  const getX = (time: number, width: number) => {
    // Current time is at 20% of the screen width (the "hit line")
    const hitLineX = width * 0.2;
    const timeDiff = time - currentTime;
    // Map 1 second to X pixels
    const pixelsPerSecond = width / VISIBLE_WINDOW; 
    return hitLineX + (timeDiff * pixelsPerSecond);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;

    const render = () => {
      // High DPI Handling
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      
      // Scale canvas resolution to match screen density
      const targetWidth = Math.floor(rect.width * dpr);
      const targetHeight = Math.floor(rect.height * dpr);

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      
      // Reset transform to identity, then scale by DPR
      // This allows us to draw using Logical Pixels (rect.width/height)
      // but have sharp results on Retina screens.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const width = rect.width;
      const height = rect.height;

      // Clear using logical dimensions
      ctx.clearRect(0, 0, width, height);

      // Draw Background Grid (Pitch Lines)
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      
      // Draw grid lines for relevant pitches
      const startPitch = Math.floor(minPitch);
      const endPitch = Math.ceil(maxPitch);

      for (let i = startPitch; i <= endPitch; i++) {
        const y = getY(i, height);
        
        // Highlight Octaves (C notes: 36, 48, 60, 72...)
        const isC = i % 12 === 0;
        
        if (isC) {
           ctx.strokeStyle = '#475569';
           ctx.lineWidth = 2;
        } else {
           ctx.strokeStyle = '#1e293b';
           ctx.lineWidth = 1;
        }
        
        // Only draw semi-tones if zoomed in enough (range < 30)
        if (PITCH_RANGE < 30 || isC || i % 12 === 5 || i % 12 === 7) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        
        // Draw Note Labels for Cs
        if (isC) {
             ctx.fillStyle = '#475569';
             ctx.font = '10px Inter';
             ctx.fillText(midiToNoteName(i), 5, y - 2);
        }
      }

      // Draw "Hit Line"
      const hitLineX = width * 0.2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hitLineX, 0);
      ctx.lineTo(hitLineX, height);
      ctx.stroke();

      // Find active notes for "Snapping" logic
      const activeNotes = notes.filter(n => 
          currentTime >= n.startTime && currentTime <= n.startTime + n.duration
      );

      // Draw Notes
      notes.forEach(note => {
        // Optimization: only draw notes within window + buffer
        if (note.startTime + note.duration < currentTime - 1 || note.startTime > currentTime + VISIBLE_WINDOW) {
          return;
        }

        const x = getX(note.startTime, width);
        const w = (note.duration * (width / VISIBLE_WINDOW));
        const y = getY(note.pitch, height);

        // Styling based on active
        const isActive = currentTime >= note.startTime && currentTime <= note.startTime + note.duration;
        
        ctx.fillStyle = isActive ? '#3b82f6' : '#64748b'; // Blue active, Slate inactive
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        
        // Draw Rounded Rect
        ctx.beginPath();
        // Fallback for browsers without roundRect if needed, but modern browsers support it
        if (ctx.roundRect) {
            ctx.roundRect(x, y, w, NOTE_HEIGHT, 4);
        } else {
            ctx.rect(x, y, w, NOTE_HEIGHT);
        }
        ctx.fill();
        ctx.stroke();

        // Draw Lyric
        if (note.lyric) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Inter';
            // Prevent lyric overlap if zooming
            ctx.fillText(note.lyric, x, y - 8);
        }
      });

      // Draw User Pitch Indicator
      if (userPitch > 0) {
        // Convert Hz to MIDI
        let userMidi = 12 * Math.log2(userPitch / 440) + 69;
        
        // --- Novice Mode: Octave Snapping Logic ---
        // If Novice mode is on, checks if we are close to an active note in a DIFFERENT octave.
        // If so, visually shift the user pointer to match the note's octave so it looks correct on screen.
        let isHitting = false;
        
        if (activeNotes.length > 0) {
            // Check against closest note
            let closestNote = activeNotes[0];
            let minDiff = Infinity;
            
            activeNotes.forEach(note => {
               const diff = Math.abs(userMidi - note.pitch);
               if (diff < minDiff) {
                 minDiff = diff;
                 closestNote = note;
               }
            });

            // If strict hit
            if (minDiff < 2.0) {
                isHitting = true;
            } 
            // If strict hit fail, check octaves for Novice
            else if (difficultyMode === 'Novice') {
                const diffDown = Math.abs((userMidi + 12) - closestNote.pitch);
                const diffUp = Math.abs((userMidi - 12) - closestNote.pitch);
                const diffDown2 = Math.abs((userMidi + 24) - closestNote.pitch);
                const diffUp2 = Math.abs((userMidi - 24) - closestNote.pitch);

                if (diffDown < 2.0) {
                    userMidi += 12; // Snap Visual
                    isHitting = true;
                } else if (diffUp < 2.0) {
                    userMidi -= 12; // Snap Visual
                    isHitting = true;
                } else if (diffDown2 < 2.0) {
                    userMidi += 24; // Snap Visual
                    isHitting = true;
                } else if (diffUp2 < 2.0) {
                    userMidi -= 24; // Snap Visual
                    isHitting = true;
                }
            }
        }
        
        const y = getY(userMidi, height);
        const x = hitLineX;

        // Trail effect / Cursor
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = isHitting ? '#22c55e' : '#ef4444'; // Green if hitting, Red if miss
        ctx.fill();
        
        ctx.shadowBlur = 10;
        ctx.shadowColor = isHitting ? '#22c55e' : '#ef4444';
        
        // Spawn particle if hitting
        if (isHitting) {
            if (Math.random() > 0.5) {
                particlesRef.current.push({
                    x: x,
                    y: y,
                    life: 1.0,
                    color: '#22c55e'
                });
            }
        }
      }
      ctx.shadowBlur = 0;

      // Update and Draw Particles
      particlesRef.current.forEach((p, index) => {
        p.life -= 0.05;
        p.x -= 3; // Move left with flow (faster than before for energy)
        p.y += (Math.random() - 0.5) * 4;
        
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;

        if (p.life <= 0) particlesRef.current.splice(index, 1);
      });

      if (isPlaying) {
        animationId = requestAnimationFrame(render);
      }
    };

    render();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [currentTime, userPitch, notes, isPlaying, difficultyMode, minPitch, maxPitch, PITCH_RANGE]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-full block"
      style={{ touchAction: 'none' }}
    />
  );
};

export default PitchVisualizer;