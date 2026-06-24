import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRawPatch } from './binary'
import { parseArchive, parseProgramBin } from './index'
import { extractProgramBins } from './unzip'

// Vitest runs with cwd = project root, where the sample files live.
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(process.cwd(), name)))

const PROG = fixture('replicant-example.mnlgxdprog')
const LIB = fixture('example-library.mnlgxdlib')

describe('.mnlgxdprog (real fixture)', () => {
  const bins = extractProgramBins(PROG)

  it('contains exactly one program binary of 1024 bytes', () => {
    expect(bins).toHaveLength(1)
    expect(bins[0]).toHaveLength(1024)
  })

  it('reads known raw fields', () => {
    const raw = readRawPatch(bins[0])
    expect(raw.name).toBe('Replicant xd')
    expect(raw.voiceModeType).toBe(4) // POLY
    expect(raw.vco1Wave).toBe(2) // SAW
    expect(raw.vco1Level).toBe(1023)
    expect(raw.multiLevel).toBe(0)
  })

  it('parses + validates into a domain patch', () => {
    const patch = parseProgramBin(bins[0])
    expect(patch.name).toBe('Replicant xd')
    expect(patch.voice.mode).toBe('POLY')
    expect(patch.vco1.wave).toBe('SAW')
    expect(patch.vco1.octave).toBe(0)
    expect(patch.vco2.wave).toBe('SAW')
    expect(patch.mixer.vco1).toBe(1)
    expect(patch.mixer.multi).toBe(0)
    expect(patch.filter.cutoff).toBeCloseTo(0.295, 2)
    expect(patch.filter.resonance).toBe(0)
    expect(patch.vco2.sync).toBe(false)
    expect(patch.multi.type).toBe('NOISE')
    expect(patch.multi.typeLabel).toBe('HIGH')
  })
})

describe('.mnlgxdlib (real fixture)', () => {
  const bins = extractProgramBins(LIB)

  it('contains multiple program binaries, all 1024 bytes', () => {
    expect(bins.length).toBeGreaterThan(1)
    expect(bins.every((b) => b.length === 1024)).toBe(true)
  })

  it('parses + validates every program without throwing', () => {
    const patches = parseArchive(LIB)
    expect(patches).toHaveLength(bins.length)
    for (const patch of patches) {
      expect(typeof patch.name).toBe('string')
      expect(patch.filter.cutoff).toBeGreaterThanOrEqual(0)
      expect(patch.filter.cutoff).toBeLessThanOrEqual(1)
    }
  })
})
