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
 * Better than standard FFT for monophonic voice pitch detection.
 */
export function autoCorrelate(buffer: Float32Array, sampleRate: number): number {
  // Implements the YIN algorithm simplified or standard autocorrelation
  let size = buffer.length;
  let rms = 0;

  for (let i = 0; i < size; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / size);

  // Noise gate
  if (rms < 0.01) {
    return -1; // Not enough signal
  }

  let r1 = 0, r2 = size - 1, thres = 0.2;
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buffer[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buffer[size - i]) < thres) { r2 = size - i; break; }
  }

  const slicedBuffer = buffer.slice(r1, r2);
  size = slicedBuffer.length;

  const c = new Array(size).fill(0);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size - i; j++) {
      c[i] = c[i] + slicedBuffer[j] * slicedBuffer[j + i];
    }
  }

  let d = 0; 
  while (c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < size; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  let T0 = maxpos;

  // Parabolic interpolation for better precision
  let x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  let a = (x1 + x3 - 2 * x2) / 2;
  let b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}
