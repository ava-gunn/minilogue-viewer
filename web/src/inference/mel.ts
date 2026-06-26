// Log-mel spectrogram, matching schema/audio.json and training/data/mel.py. Conventions:
//   - periodic Hann window (fftbins=True)
//   - center = False (no reflective padding)
//   - power spectrum (|X|^2)
//   - HTK mel scale, triangular filters, no area normalization (librosa htk=True, norm=None)
//   - log(mel + 1e-6)
// Output is a Float32Array of shape [N_MELS, N_FRAMES] flattened row-major (mel-major),
// matching the ONNX input tensor [1, 1, N_MELS, N_FRAMES].

import {
  FMAX,
  FMIN,
  HOP_LENGTH,
  N_FFT,
  N_FRAMES,
  N_MELS,
  SAMPLE_RATE,
} from './contract'
import { fftRadix2 } from './fft'

const N_FREQS = N_FFT / 2 + 1

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700)
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1)

function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  }
  return w
}

// Triangular mel filterbank: N_MELS rows of N_FREQS weights.
function melFilterbank(): Float32Array[] {
  const melMin = hzToMel(FMIN)
  const melMax = hzToMel(FMAX)
  const edges = Array.from({ length: N_MELS + 2 }, (_, i) =>
    melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1)),
  )
  const fftFreq = (k: number): number => (k * SAMPLE_RATE) / N_FFT

  const bank: Float32Array[] = []
  for (let m = 1; m <= N_MELS; m++) {
    const left = edges[m - 1]
    const center = edges[m]
    const right = edges[m + 1]
    const row = new Float32Array(N_FREQS)
    for (let k = 0; k < N_FREQS; k++) {
      const f = fftFreq(k)
      let weight = 0
      if (f >= left && f <= center) weight = (f - left) / (center - left)
      else if (f > center && f <= right) weight = (right - f) / (right - center)
      if (weight > 0) row[k] = weight
    }
    bank.push(row)
  }
  return bank
}

const WINDOW = hannWindow(N_FFT)
const FILTERBANK = melFilterbank()

/** Compute the log-mel spectrogram of a fixed-length mono signal (>= N_SAMPLES). */
export function logMel(signal: Float32Array): Float32Array {
  const out = new Float32Array(N_MELS * N_FRAMES)
  const re = new Float32Array(N_FFT)
  const im = new Float32Array(N_FFT)
  const power = new Float32Array(N_FREQS)

  for (let frame = 0; frame < N_FRAMES; frame++) {
    const start = frame * HOP_LENGTH
    for (let i = 0; i < N_FFT; i++) {
      re[i] = (signal[start + i] ?? 0) * WINDOW[i]
      im[i] = 0
    }
    fftRadix2(re, im)
    for (let k = 0; k < N_FREQS; k++) power[k] = re[k] * re[k] + im[k] * im[k]

    for (let m = 0; m < N_MELS; m++) {
      const row = FILTERBANK[m]
      let sum = 0
      for (let k = 0; k < N_FREQS; k++) sum += row[k] * power[k]
      out[m * N_FRAMES + frame] = Math.log(sum + 1e-6)
    }
  }
  return out
}
