// This service handles the raw signal processing of the user's voice.
// It does NOT use AI. It uses autocorrelation to determine fundamental frequency.

export const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Pre-allocate buffers to avoid Garbage Collection during the game loop
const MAX_SAMPLES = 1024; // Enough for low frequency detection down to ~45Hz
const CORRELATION_BUFFER = new Float32Array(MAX_SAMPLES);

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
 * Heavily optimized for real-time 60fps usage.
 */
export function autoCorrelate(buffer: Float32Array, sampleRate: number): number {
  // 1. RMS Calculation (Noise Gate)
  // Check first 512 samples for volume to exit early
  let rms = 0;
  const rmsSize = Math.min(buffer.length, 512);
  for (let i = 0; i < rmsSize; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / rmsSize);

  if (rms < 0.015) { 
    return -1; 
  }

  // 2. Frequency Range Optimization
  // We only care about human voice: 70Hz (C2) to 1100Hz (C6)
  // Lag = sampleRate / frequency
  const minLag = Math.floor(sampleRate / 1100); 
  const maxLag = Math.floor(sampleRate / 70);
  
  // We don't need to correlate the entire buffer against itself. 
  // A window of ~512 samples is enough to detect the period.
  const integrationWindow = 512; 
  
  // Ensure we don't go out of bounds
  if (maxLag + integrationWindow > buffer.length) {
      // Buffer too small for low freq, just return -1 or fallback
      return -1;
  }

  // 3. Autocorrelation Loop
  // Search for the best lag within the human vocal range
  let bestLag = -1;
  let maxCorrelation = 0;
  
  // Reuse the static buffer for storing correlation values if needed, 
  // but here we just track max on the fly to save even writing to memory.
  
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    
    // Inner loop: The hot path.
    // Optimization: Skip every other sample (stride=2). 
    // This cuts CPU usage by 50% with negligible precision loss for pitch.
    for (let i = 0; i < integrationWindow; i += 2) {
      sum += buffer[i] * buffer[i + lag];
    }
    
    // Store in our reusable buffer just for the peak finding logic's need for neighbors
    // We map lag to index 0...N to fit in small buffer
    const index = lag - minLag;
    if (index < CORRELATION_BUFFER.length) {
        CORRELATION_BUFFER[index] = sum;
    }

    if (sum > maxCorrelation) {
      maxCorrelation = sum;
      bestLag = lag;
    }
  }

  // Threshold to avoid random noise matches
  // The sum is roughly proportional to integrationWindow * amplitude^2.
  // We can just rely on the RMS gate mostly, but checking peak quality helps.
  // (Simplified for speed here)

  // 4. Parabolic Interpolation
  // Refine the peak estimate using neighbors
  let T0 = bestLag;
  
  // We stored correlations in CORRELATION_BUFFER offset by minLag
  const peakIndex = bestLag - minLag;
  
  if (peakIndex > 0 && peakIndex < CORRELATION_BUFFER.length - 1) {
      const x1 = CORRELATION_BUFFER[peakIndex - 1];
      const x2 = CORRELATION_BUFFER[peakIndex];
      const x3 = CORRELATION_BUFFER[peakIndex + 1];
      
      const a = (x1 + x3 - 2 * x2) / 2;
      const b = (x3 - x1) / 2;
      if (a !== 0) {
          T0 = T0 - b / (2 * a);
      }
  }

  return sampleRate / T0;
}