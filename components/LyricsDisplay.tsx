import React, { useEffect, useRef, useState } from 'react';
import { Note } from '../types';

interface LyricsDisplayProps {
  notes: Note[];
  currentTimeRef: React.MutableRefObject<number>;
  isPlaying: boolean;
}

// A "Line" is a sequence of notes that should be displayed together.
interface KaraokeLine {
  notes: Note[];
  startTime: number;
  endTime: number;
}

const LyricsDisplay: React.FC<LyricsDisplayProps> = ({ notes, currentTimeRef, isPlaying }) => {
  const [currentLine, setCurrentLine] = useState<KaraokeLine | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Pre-process notes into lines once when notes change
  const linesRef = useRef<KaraokeLine[]>([]);

  useEffect(() => {
    if (!notes || notes.length === 0) return;

    const lines: KaraokeLine[] = [];
    let currentChunk: Note[] = [];
    
    notes.forEach((note, index) => {
       if (!note.lyric || note.lyric.trim() === '') {
           // Skip empty lyrics for text display purposes, but they might be rests
           // Actually, sometimes people put empty notes for rhythm. Let's ignore for now.
       }

       if (currentChunk.length === 0) {
           currentChunk.push(note);
       } else {
           const prevNote = currentChunk[currentChunk.length - 1];
           const gap = note.startTime - (prevNote.startTime + prevNote.duration);
           
           // If gap is larger than 1.2 seconds, start new line
           if (gap > 1.2) {
               lines.push({
                   notes: [...currentChunk],
                   startTime: currentChunk[0].startTime,
                   endTime: currentChunk[currentChunk.length - 1].startTime + currentChunk[currentChunk.length - 1].duration
               });
               currentChunk = [note];
           } else {
               currentChunk.push(note);
           }
       }
    });

    // Add last chunk
    if (currentChunk.length > 0) {
        lines.push({
            notes: [...currentChunk],
            startTime: currentChunk[0].startTime,
            endTime: currentChunk[currentChunk.length - 1].startTime + currentChunk[currentChunk.length - 1].duration
        });
    }

    linesRef.current = lines;
  }, [notes]);

  // Animation Loop to update highlighting
  useEffect(() => {
    let animId: number;

    const update = () => {
        if (!isPlaying) return;
        const time = currentTimeRef.current;
        
        // 1. Determine Current Line
        // Show line if time is within [startTime - 1s, endTime + 1s]
        const activeLine = linesRef.current.find(line => 
            time >= line.startTime - 2.0 && time <= line.endTime + 1.0
        );

        // React State update only if line changes (coarse update)
        // To avoid flickering, we only set it if it's different
        // We cheat a bit: we use a ref for the current rendered line index to avoid scanning the array every frame if we can
        // But scanning 100 lines is fast enough.
        
        // However, updating the DOM for highlighting needs to be done via Refs if we want 60fps without React Renders.
        // OR we just use CSS variables?
        // Let's use direct DOM manipulation for the "active" class on spans.
        
        if (containerRef.current) {
            const spans = containerRef.current.querySelectorAll('span');
            spans.forEach((span) => {
                const start = parseFloat(span.dataset.start || '0');
                const duration = parseFloat(span.dataset.duration || '0');
                
                if (time >= start + duration) {
                    span.style.color = '#3b82f6'; // Blue (Passed)
                    span.style.transform = 'scale(1)';
                } else if (time >= start) {
                    span.style.color = '#60a5fa'; // Light Blue (Singing now)
                    span.style.transform = 'scale(1.1)';
                    span.style.textShadow = '0 0 10px rgba(96, 165, 250, 0.8)';
                } else {
                    span.style.color = 'white'; // White (Future)
                    span.style.transform = 'scale(1)';
                    span.style.textShadow = 'none';
                }
            });
        }
        
        // Only trigger react re-render if the LINE ITSELF changes (text content change)
        // We use a functional update to check previous state inside the setter or just ref comparison?
        // Since activeLine is an object reference from linesRef, direct comparison works.
        setCurrentLine(prev => (prev === activeLine ? prev : (activeLine || null)));

        animId = requestAnimationFrame(update);
    };

    if (isPlaying) {
        animId = requestAnimationFrame(update);
    }
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, currentTimeRef]);

  if (!currentLine) return null;

  return (
    <div className="flex flex-col items-center justify-center w-full px-8 text-center animate-fade-in">
        <div ref={containerRef} className="flex flex-wrap justify-center gap-x-3 gap-y-1">
            {currentLine.notes.map((note, i) => (
                <span 
                    key={i}
                    data-start={note.startTime}
                    data-duration={note.duration}
                    className="text-4xl sm:text-5xl font-bold transition-all duration-75 inline-block"
                    style={{ color: 'white' }}
                >
                    {note.lyric}
                </span>
            ))}
        </div>
    </div>
  );
};

export default LyricsDisplay;