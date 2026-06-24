import { describe, expect, it } from 'vitest'
import { N_FRAMES, N_MELS, N_SAMPLES } from './contract'
import { fftRadix2 } from './fft'
import { logMel } from './mel'

describe('fftRadix2', () => {
  it('puts a DC signal entirely in bin 0', () => {
    const n = 8
    const re = new Float32Array(n).fill(1)
    const im = new Float32Array(n)
    fftRadix2(re, im)
    expect(re[0]).toBeCloseTo(8, 5)
    for (let k = 1; k < n; k++) expect(re[k]).toBeCloseTo(0, 5)
  })

  it('matches the DFT for a pure tone', () => {
    const n = 16
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 2 * i) / n)
    fftRadix2(re, im)
    const mag = (k: number): number => Math.hypot(re[k], im[k])
    expect(mag(2)).toBeCloseTo(n / 2, 4)
    expect(mag(14)).toBeCloseTo(n / 2, 4) // conjugate bin
    expect(mag(1)).toBeCloseTo(0, 4)
  })
})

describe('logMel', () => {
  const tone = (hz: number): Float32Array => {
    const s = new Float32Array(N_SAMPLES)
    for (let i = 0; i < N_SAMPLES; i++) {
      s[i] = Math.sin((2 * Math.PI * hz * i) / 44100)
    }
    return s
  }
  const sum = (a: Float32Array): number => a.reduce((acc, v) => acc + v, 0)

  it('returns a finite [N_MELS, N_FRAMES] tensor', () => {
    const mel = logMel(tone(261.63))
    expect(mel).toHaveLength(N_MELS * N_FRAMES)
    expect([...mel].every(Number.isFinite)).toBe(true)
  })

  it('has more total energy for a tone than for silence', () => {
    expect(sum(logMel(tone(440)))).toBeGreaterThan(
      sum(logMel(new Float32Array(N_SAMPLES))),
    )
  })
})
