import React, { useEffect, useRef, useState } from 'react';
import { Note } from '../types';

interface LyricsDisplayProps {
  notes: Note[];
  currentTimeRef: React.MutableRefObject<number>;
  isPlaying: boolean;
  noteHitsRef: React.MutableRefObject<Set<number>>;
}

// A "Line" is a sequence of notes that should be displayed together.
interface KaraokeLine {
  notes: { note: Note, originalIndex: number }[];
  startTime: number;
  endTime: number;
}

const LyricsDisplay: React.FC<LyricsDisplayProps> = ({ notes, currentTimeRef, isPlaying, noteHitsRef }) => {
  const [activeLineIndex, setActiveLineIndex] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Pre-process notes into lines once when notes change
  const linesRef = useRef<KaraokeLine[]>([]);

  useEffect(() => {
    if (!notes || notes.length === 0) return;

    const lines: KaraokeLine[] = [];
    let currentChunk: { note: Note, originalIndex: number }[] = [];
    
    // Config for 2-line mode
    // We can fit a bit more text now that we have 2 lines, but keeping it readable is key.
    const MAX_CHARS = 30; 
    
    notes.forEach((note, index) => {
       // Skip technical notes
       if (!note.lyric || note.lyric.trim() === '') {
           // still include for timing
       }
       
       const noteItem = { note, originalIndex: index };

       if (currentChunk.length === 0) {
           currentChunk.push(noteItem);
       } else {
           const prevItem = currentChunk[currentChunk.length - 1];
           const prevNote = prevItem.note;
           const gap = note.startTime - (prevNote.startTime + prevNote.duration);
           
           const currentLength = currentChunk.reduce((acc, n) => acc + (n.note.lyric?.length || 0), 0);
           
           let shouldSplit = false;
           if (gap > 2.0) shouldSplit = true; // Longer gap tolerance
           if (currentLength > MAX_CHARS) shouldSplit = true;

           if (shouldSplit) {
               lines.push({
                   notes: [...currentChunk],
                   startTime: currentChunk[0].note.startTime,
                   endTime: currentChunk[currentChunk.length - 1].note.startTime + currentChunk[currentChunk.length - 1].note.duration
               });
               currentChunk = [noteItem];
           } else {
               currentChunk.push(noteItem);
           }
       }
    });

    if (currentChunk.length > 0) {
        lines.push({
            notes: [...currentChunk],
            startTime: currentChunk[0].note.startTime,
            endTime: currentChunk[currentChunk.length - 1].note.startTime + currentChunk[currentChunk.length - 1].note.duration
        });
    }

    linesRef.current = lines;
    setActiveLineIndex(0);
  }, [notes]);

  // Animation Loop for Highlighting & Scroll Logic
  useEffect(() => {
    let animId: number;

    const update = () => {
        if (!isPlaying) return;
        const time = currentTimeRef.current;
        const lines = linesRef.current;
        
        // 1. Determine which line should be the "Top" line.
        // We stick with a line until it is finished + small buffer.
        // Use findIndex to find the first line that ends in the future (or just finished).
        let newIndex = lines.findIndex(line => time <= line.endTime + 0.5);
        
        // If all lines finished (findIndex returns -1), set to length to clear screen eventually
        if (newIndex === -1 && lines.length > 0) {
             // check if we are truly past the last line
             if (time > lines[lines.length - 1].endTime + 0.5) {
                 newIndex = lines.length;
             } else {
                 newIndex = 0; // fallback
             }
        }
        
        // Only update React state if index changed to prevent re-renders
        setActiveLineIndex(prev => {
            if (prev !== newIndex) return newIndex;
            return prev;
        });
        
        // 2. Imperative DOM manipulation for colors (Performance)
        if (containerRef.current) {
            const spans = containerRef.current.querySelectorAll('span');
            spans.forEach((span) => {
                const start = parseFloat(span.dataset.start || '0');
                const duration = parseFloat(span.dataset.duration || '0');
                const index = parseInt(span.dataset.index || '-1');
                const end = start + duration;
                
                const isHit = noteHitsRef.current.has(index);

                // Check if this span belongs to the "Active" line (top line) or "Next" line
                // We can check dataset line index if we added it, or infer from time.
                // Simpler: Just style based on time relative to the note.
                
                if (time >= end) {
                    // Passed
                    span.style.color = isHit ? '#4ade80' : '#475569'; // Green or Slate-600
                    span.style.transform = 'scale(1)';
                    span.style.opacity = isHit ? '1' : '0.5';
                    span.style.textShadow = 'none';
                    span.style.fontWeight = '800'; // Bold
                } else if (time >= start) {
                    // Currently Singing
                    span.style.color = '#fbbf24'; // Amber-400
                    span.style.transform = 'scale(1.1)';
                    span.style.opacity = '1';
                    span.style.textShadow = '0 0 20px rgba(251, 191, 36, 0.6)';
                    span.style.fontWeight = '900'; // Extra Bold
                } else {
                    // Future
                    // Is this note in the active line or the next line?
                    // We can use a simplified check: is it very close to start?
                    const timeUntilStart = start - time;
                    const isUpcomingSoon = timeUntilStart < 2.0;

                    span.style.color = 'white';
                    span.style.transform = 'scale(1)';
                    span.style.opacity = isUpcomingSoon ? '0.9' : '0.4'; // Dim next line until close
                    span.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
                    span.style.fontWeight = '600';
                }
            });
        }

        animId = requestAnimationFrame(update);
    };

    if (isPlaying) {
        animId = requestAnimationFrame(update);
    }
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, currentTimeRef, noteHitsRef]);

  // Render the current active line and the next one
  const visibleLines = linesRef.current.slice(activeLineIndex, activeLineIndex + 2);

  if (!linesRef.current.length) return null;

  return (
    <div className="flex flex-col items-center justify-end w-full px-4 text-center animate-fade-in pointer-events-none pb-8">
        <div 
          ref={containerRef} 
          className="flex flex-col gap-4 items-center justify-center w-full max-w-6xl transition-all duration-500 ease-in-out"
        >
            {visibleLines.map((line, lineIndex) => {
                const isFirstLine = lineIndex === 0;
                
                return (
                    <div 
                        key={line.startTime} 
                        className={`flex flex-wrap justify-center items-baseline gap-x-2 transition-all duration-500 ${isFirstLine ? 'scale-100 opacity-100' : 'scale-90 opacity-60'}`}
                    >
                        {line.notes.map((item, i) => (
                            <span 
                                key={i}
                                data-start={item.note.startTime}
                                data-duration={item.note.duration}
                                data-index={item.originalIndex}
                                className={`font-black tracking-tight leading-tight transition-all duration-75 ease-out ${isFirstLine ? 'text-4xl md:text-6xl' : 'text-2xl md:text-4xl'}`}
                                style={{ 
                                    color: 'white',
                                    fontFamily: '"Inter", sans-serif',
                                    WebkitTextStroke: '1px rgba(0,0,0,0.5)'
                                }}
                            >
                                {item.note.lyric}
                            </span>
                        ))}
                    </div>
                );
            })}
            
            {/* Spacer if no next line to keep layout consistent */}
            {visibleLines.length === 1 && (
                 <div className="h-12 md:h-16 w-full"></div>
            )}
        </div>
    </div>
  );
};

export default LyricsDisplay;