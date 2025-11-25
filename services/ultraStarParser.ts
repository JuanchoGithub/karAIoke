import { SongData, Note } from '../types';

// UltraStar pitch 0 is C4 (MIDI 60). 
// UltraStar pitches are semitones relative to C4.
const ULTRASTAR_BASE_PITCH = 60;

export function parseUltraStarTxt(txt: string): SongData {
  const lines = txt.split(/\r?\n/);
  const headers: Record<string, string> = {};
  const notes: Note[] = [];

  let currentBpm = 0;
  let gap = 0; // in milliseconds
  let videoId = '';
  let coverUrl = '';
  let backgroundUrl = '';

  // 1. Parse Headers
  for (const line of lines) {
    if (line.startsWith('#')) {
      const parts = line.substring(1).split(':');
      if (parts.length >= 2) {
        const key = parts[0].toUpperCase().trim();
        // Rejoin the rest in case the value has colons (like URLs or times)
        const value = parts.slice(1).join(':').trim();
        headers[key] = value;
      }
    }
  }

  // 2. Extract Metadata
  const title = headers['TITLE'] || 'Unknown Title';
  const artist = headers['ARTIST'] || 'Unknown Artist';
  
  // Extract BPM
  // Standard UltraStar calc: (15 / BPM) = seconds per beat.
  const rawBpm = parseFloat(headers['BPM']?.replace(',', '.') || '300');
  currentBpm = rawBpm;
  
  gap = parseFloat(headers['GAP']?.replace(',', '.') || '0');
  
  // Extract Video ID, Cover, Background from #VIDEO tag
  // Format: #VIDEO:v=ID,co=COVER_URL,bg=BG_URL
  const rawVideo = headers['VIDEO'] || '';
  
  // A. Extract Video ID (v=...)
  // Handle optional spaces and different separators
  if (rawVideo.includes('v=')) {
    const match = rawVideo.match(/v=([a-zA-Z0-9_-]{11})/);
    if (match) {
      videoId = match[1].trim();
    }
  } else if (headers['YOUTUBE']) {
     videoId = headers['YOUTUBE'].trim();
  }

  // B. Extract Cover Image (co=...)
  if (rawVideo.includes('co=')) {
      // Match from co= until comma or end of string
      const match = rawVideo.match(/co=([^,\r\n]+)/);
      if (match) {
          coverUrl = match[1];
      }
  }
  // Fallback to #COVER tag if no co= param
  if (!coverUrl && headers['COVER']) {
      coverUrl = headers['COVER'];
  }

  // C. Extract Background Image (bg=...)
  if (rawVideo.includes('bg=')) {
      const match = rawVideo.match(/bg=([^,\r\n]+)/);
      if (match) {
          backgroundUrl = match[1];
      }
  }
  // Fallback to #BACKGROUND tag
  if (!backgroundUrl && headers['BACKGROUND']) {
      backgroundUrl = headers['BACKGROUND'];
  }

  if (!videoId) {
    console.warn("No Video ID found in TXT headers");
  }

  // 3. Parse Notes
  const secondsPerBeat = 15 / currentBpm;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith('#')) continue;
    
    // Note format: TYPE STARTBEAT DURATION PITCH TEXT
    const parts = line.split(/\s+/); 
    const type = parts[0];

    if (type === 'E') break; // End of song

    if (type === ':' || type === '*' || type === 'F' || type === 'R' || type === 'G') {
       if (parts.length < 5) continue;

       const startBeat = parseInt(parts[1]);
       const durationBeats = parseInt(parts[2]);
       const pitch = parseInt(parts[3]);
       // Join the rest as text
       let text = parts.slice(4).join(' ');

       // Calculate timing
       const startTime = (gap / 1000) + (startBeat * secondsPerBeat);
       const duration = durationBeats * secondsPerBeat;
       
       // Calculate Pitch
       const midiPitch = ULTRASTAR_BASE_PITCH + pitch;

       notes.push({
         startTime,
         duration,
         pitch: midiPitch,
         lyric: text
       });
    }
  }

  return {
    title,
    artist,
    videoId,
    coverUrl,
    backgroundUrl,
    bpm: rawBpm / 4,
    notes,
    difficulty: 'Medium',
    sourceType: 'USDB'
  };
}