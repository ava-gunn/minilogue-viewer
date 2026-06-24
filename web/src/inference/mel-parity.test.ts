import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { N_FRAMES, N_MELS } from './contract'
import { logMel } from './mel'

// Pins mel.ts against the Python golden (training/data/mel.py) so the encoder gets the
// same log-mel in training (numpy float64 FFT) and inference (this float32 FFT). The two
// differ only in the FFT's internal precision; the tolerance covers that gap.
interface Golden {
  signal: { sample_rate: number; length: number; tones: [number, number][] }
  mel: number[]
}

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(
  readFileSync(resolve(here, '../../../schema/mel-golden.json'), 'utf8'),
) as Golden

function referenceSignal(): Float32Array {
  const { sample_rate, length, tones } = golden.signal
  const sig = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let s = 0
    for (const [freq, amp] of tones) {
      s += amp * Math.sin((2 * Math.PI * freq * i) / sample_rate)
    }
    sig[i] = s
  }
  return sig
}

describe('mel.ts ↔ Python golden parity', () => {
  it('reproduces schema/mel-golden.json within tolerance', () => {
    const mel = logMel(referenceSignal())
    expect(mel).toHaveLength(N_MELS * N_FRAMES)
    expect(mel.length).toBe(golden.mel.length)

    let maxDiff = 0
    for (let i = 0; i < mel.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(mel[i] - golden.mel[i]))
    }
    // Measured max diff ≈ 1.7e-3 (float32 browser FFT vs float64 numpy FFT); a real
    // convention mismatch would be orders of magnitude larger.
    expect(maxDiff).toBeLessThan(1e-2)
  })
})
