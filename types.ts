export interface Note {
  startTime: number; // in seconds
  duration: number; // in seconds
  pitch: number; // MIDI note number (e.g., 60 is Middle C)
  lyric?: string;
}

export interface SearchResult {
  title: string;
  artist: string;
  videoId: string;
  channelName?: string;
}

export interface SongData {
  title: string;
  artist: string;
  videoId: string; // YouTube Video ID
  bpm?: number;
  notes: Note[];
  difficulty: 'Easy' | 'Medium' | 'Hard';
}

export enum GameStatus {
  IDLE = 'IDLE',
  SEARCHING = 'SEARCHING',
  SELECTING = 'SELECTING', // New state for choosing a song
  PREPARING = 'PREPARING', // Analyzing/Loading chart
  PLAYING = 'PLAYING',
  FINISHED = 'FINISHED'
}

export interface ScoreState {
  currentScore: number;
  combo: number;
  maxCombo: number;
  perfectHits: number;
  goodHits: number;
  misses: number;
  audienceMood: number; // 0 to 100
}