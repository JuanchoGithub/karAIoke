import React, { useEffect, useRef } from 'react';
import { Note, ScoreState } from '../types';
import { midiToNoteName } from '../services/audioAnalysis';

interface PitchVisualizerProps {
  currentTime: number;
  userPitch: number; // in Hz
  notes: Note[];
  scoreState: ScoreState;
  isPlaying: boolean;
}

const PitchVisualizer: React.FC<PitchVisualizerProps> = ({
  currentTime,
  userPitch,
  notes,
  scoreState,
  isPlaying
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<{x: number, y: number, life: number, color: string}[]>([]);

  // Configuration
  const VISIBLE_WINDOW = 4; // seconds visible on screen
  const NOTE_HEIGHT = 10;
  const MIN_PITCH = 45; // F2
  const MAX_PITCH = 84; // C6
  const PITCH_RANGE = MAX_PITCH - MIN_PITCH;

  // Helper to map pitch to Y coordinate (inverted because canvas Y=0 is top)
  const getY = (midiPitch: number, height: number) => {
    const normalized = (midiPitch - MIN_PITCH) / PITCH_RANGE;
    // Clamp
    const clamped = Math.max(0, Math.min(1, normalized));
    return height - (clamped * height) - (NOTE_HEIGHT / 2);
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
      // Resize handling
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      }
      
      const width = canvas.width;
      const height = canvas.height;

      // Clear
      ctx.clearRect(0, 0, width, height);

      // Draw Background Grid (Pitch Lines)
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      for (let i = MIN_PITCH; i <= MAX_PITCH; i++) {
        if (i % 12 === 0 || i % 12 === 5 || i % 12 === 7) { // Highlight C, F, G
          const y = getY(i, height);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
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

      // Draw Notes
      notes.forEach(note => {
        // Optimization: only draw notes within window + buffer
        if (note.startTime + note.duration < currentTime - 1 || note.startTime > currentTime + VISIBLE_WINDOW) {
          return;
        }

        const x = getX(note.startTime, width);
        const w = (note.duration * (width / VISIBLE_WINDOW));
        const y = getY(note.pitch, height);

        // Styling based on if it's being hit (this logic is simplified visual only, real logic is in parent)
        const isActive = currentTime >= note.startTime && currentTime <= note.startTime + note.duration;
        
        ctx.fillStyle = isActive ? '#3b82f6' : '#64748b'; // Blue active, Slate inactive
        ctx.strokeStyle = '#fff';
        
        // Draw Rounded Rect
        ctx.beginPath();
        ctx.roundRect(x, y, w, NOTE_HEIGHT, 4);
        ctx.fill();
        ctx.stroke();

        // Draw Lyric
        if (note.lyric) {
            ctx.fillStyle = '#fff';
            ctx.font = '14px Inter';
            ctx.fillText(note.lyric, x, y - 5);
        }
      });

      // Draw User Pitch Indicator
      if (userPitch > 0) {
        // Convert Hz to MIDI
        const userMidi = 12 * Math.log2(userPitch / 440) + 69;
        
        const y = getY(userMidi, height);
        const x = hitLineX;

        // Trail effect
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444'; // Red for user
        ctx.fill();
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ef4444';
        
        // Add particles if hitting a note
        // (Simplified check against any note)
        const isHitting = notes.some(n => 
          currentTime >= n.startTime && 
          currentTime <= n.startTime + n.duration &&
          Math.abs(n.pitch - userMidi) < 1.5
        );

        if (isHitting) {
            ctx.fillStyle = '#22c55e'; // Green if hitting!
            ctx.fill();
            ctx.shadowColor = '#22c55e';
            
            // Spawn particle
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
        p.x -= 2; // Move left with flow
        p.y += (Math.random() - 0.5) * 2;
        
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
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
  }, [currentTime, userPitch, notes, isPlaying]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-full block"
    />
  );
};

export default PitchVisualizer;
