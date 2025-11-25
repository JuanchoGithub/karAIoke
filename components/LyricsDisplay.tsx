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
  const [currentLine, setCurrentLine] = useState<KaraokeLine | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Pre-process notes into lines once when notes change
  const linesRef = useRef<KaraokeLine[]>([]);

  useEffect(() => {
    if (!notes || notes.length === 0) return;

    const lines: KaraokeLine[] = [];
    let currentChunk: { note: Note, originalIndex: number }[] = [];
    
    // Config for "Big Ass Letters" mode
    // We want short phrases (e.g. 3-6 words) so we can make the font huge.
    const MAX_CHARS = 25; 
    
    notes.forEach((note, index) => {
       // Skip technical notes without lyrics (like binders often represented as ~)
       if (!note.lyric || note.lyric.trim() === '') {
           // We still include them in the chunk for timing, but don't count length
       }
       
       const noteItem = { note, originalIndex: index };

       if (currentChunk.length === 0) {
           currentChunk.push(noteItem);
       } else {
           const prevItem = currentChunk[currentChunk.length - 1];
           const prevNote = prevItem.note;
           const gap = note.startTime - (prevNote.startTime + prevNote.duration);
           
           // Calculate current char length of the chunk
           const currentLength = currentChunk.reduce((acc, n) => acc + (n.note.lyric?.length || 0), 0);
           
           // Split conditions:
           // 1. Long silence gap (> 1.0s)
           // 2. Line is getting too long (> 25 chars) AND we aren't in a tiny gap (don't break words if possible)
           
           let shouldSplit = false;
           if (gap > 1.0) shouldSplit = true;
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

    // Add last chunk
    if (currentChunk.length > 0) {
        lines.push({
            notes: [...currentChunk],
            startTime: currentChunk[0].note.startTime,
            endTime: currentChunk[currentChunk.length - 1].note.startTime + currentChunk[currentChunk.length - 1].note.duration
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
        // Show line slightly earlier (-0.5s) so the user can read ahead, stay until finished (+0.5s)
        const activeLine = linesRef.current.find(line => 
            time >= line.startTime - 1.5 && time <= line.endTime + 1.0
        );
        
        // Direct DOM manipulation for high performance highlighting
        if (containerRef.current) {
            const spans = containerRef.current.querySelectorAll('span');
            spans.forEach((span) => {
                const start = parseFloat(span.dataset.start || '0');
                const duration = parseFloat(span.dataset.duration || '0');
                const index = parseInt(span.dataset.index || '-1');
                const end = start + duration;
                
                const isHit = noteHitsRef.current.has(index);

                // Karaoke Logic
                if (time >= end) {
                    // Passed
                    // If Hit -> Green, If Miss -> Gray/Slate
                    span.style.color = isHit ? '#4ade80' : '#475569'; 
                    span.style.transform = 'scale(1)';
                    span.style.opacity = isHit ? '1' : '0.6';
                    span.style.textShadow = '0 0 0 transparent';
                } else if (time >= start) {
                    // Active (Singing Now)
                    span.style.color = '#fbbf24'; // Amber/Gold for active
                    span.style.transform = 'scale(1.15) translateY(-5px)';
                    span.style.opacity = '1';
                    span.style.textShadow = '0 0 20px rgba(251, 191, 36, 0.8), 2px 2px 0px rgba(0,0,0,0.5)';
                } else {
                    // Future
                    span.style.color = 'white';
                    span.style.transform = 'scale(1)';
                    span.style.opacity = '0.9';
                    span.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
                }
            });
        }
        
        // React State update only if line changes object reference
        setCurrentLine(prev => (prev === activeLine ? prev : (activeLine || null)));

        animId = requestAnimationFrame(update);
    };

    if (isPlaying) {
        animId = requestAnimationFrame(update);
    }
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, currentTimeRef, noteHitsRef]);

  if (!currentLine) return null;

  return (
    <div className="flex flex-col items-center justify-end w-full px-4 text-center animate-fade-in pointer-events-none">
        <div 
          ref={containerRef} 
          className="flex flex-wrap justify-center items-baseline gap-x-2 gap-y-2 max-w-5xl mx-auto transition-all duration-300"
        >
            {currentLine.notes.map((item, i) => (
                <span 
                    key={i}
                    data-start={item.note.startTime}
                    data-duration={item.note.duration}
                    data-index={item.originalIndex}
                    className="text-5xl md:text-7xl font-black tracking-tight leading-tight transition-all duration-100 ease-out"
                    style={{ 
                        color: 'white',
                        fontFamily: '"Inter", sans-serif',
                        WebkitTextStroke: '2px rgba(0,0,0,0.3)' // Subtle outline for contrast
                    }}
                >
                    {item.note.lyric}
                </span>
            ))}
        </div>
    </div>
  );
};

export default LyricsDisplay;