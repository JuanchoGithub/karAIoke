// This service handles the raw signal processing of the user's voice.
// It does NOT use AI. It uses autocorrelation to determine fundamental frequency.

export const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * Converts a frequency in Hz to a MIDI note number.
 * formula: 12 * log2(frequency / 440) + 69
 */
export function frequencyToMidi(frequency: number): number {
  if (frequency === 0) return 0;
  return 12 * Math.log2(frequency / 440) + 69;
}

/**
 * Converts a MIDI note number to a frequency string (e.g., "C4").
 */
export function midiToNoteName(midi: number): string {
  const noteIndex = Math.round(midi) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${noteStrings[noteIndex]}${octave}`;
}

/**
 * Autocorrelation algorithm to detect pitch from audio buffer.
 * Optimized for human vocal range (50Hz - 2000Hz).
 */
export function autoCorrelate(buffer: Float32Array, sampleRate: number): number {
  let size = buffer.length;
  let rms = 0;

  // 1. Calculate RMS for noise gate
  // Optimization: standard loop
  for (let i = 0; i < size; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / size);

  // Noise gate
  if (rms < 0.015) { // Slightly increased threshold
    return -1; 
  }

  // 2. Limit search range for optimization
  // Human voice usually > 50Hz. 
  // Max Lag = sampleRate / minFreq. 
  // 48000 / 50 = 960 samples. 
  // We don't need to correlate the full 2048 buffer against itself fully.
  const MAX_LAG = Math.floor(sampleRate / 50);
  
  // Start index to trim beginning silence/transients
  let r1 = 0;
  let r2 = size - 1;
  const thres = 0.2;

  // Simple trim
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buffer[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buffer[size - i]) < thres) { r2 = size - i; break; }
  }

  const slicedBuffer = buffer.slice(r1, r2);
  size = slicedBuffer.length;
  
  // Limit the calculation loop
  // We only care about lags up to MAX_LAG or size, whichever is smaller.
  const searchSize = Math.min(size, MAX_LAG);

  const c = new Float32Array(searchSize);
  
  // Autocorrelation loop
  // O(N * M) where N is size and M is searchSize.
  // By limiting M to ~900 instead of 2048, we reduce ops by 50%+.
  for (let i = 0; i < searchSize; i++) {
    let sum = 0;
    // Unrolling or further optimization could happen here, 
    // but limiting searchSize is the biggest win.
    for (let j = 0; j < size - i; j++) {
      sum += slicedBuffer[j] * slicedBuffer[j + i];
    }
    c[i] = sum;
  }

  // Find peak
  let d = 0; 
  while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  
  for (let i = d; i < searchSize; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  let T0 = maxpos;

  // Parabolic interpolation for better precision
  if (T0 > 0 && T0 < searchSize - 1) {
      let x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
      let a = (x1 + x3 - 2 * x2) / 2;
      let b = (x3 - x1) / 2;
      if (a) T0 = T0 - b / (2 * a);
  }

  return sampleRate / T0;
}