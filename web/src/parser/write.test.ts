import { describe, expect, it } from 'vitest'
import { readRawPatch } from './binary'
import { readRawById, writeProgBin } from './write'

const template = (): Uint8Array => {
  const buf = new Uint8Array(1024)
  buf.set([0x50, 0x52, 0x4f, 0x47], 0) // "PROG" magic so readRawPatch accepts it
  return buf
}

describe('writeProgBin', () => {
  it('round-trips raw values through readRawPatch (8-bit + 10-bit LE)', () => {
    const prog = writeProgBin(template(), {
      octave: 4, // 8-bit
      vco1_wave: 2, // 8-bit discrete (SAW)
      cutoff: 800, // 10-bit little-endian
      mixer_vco1: 1023, // 10-bit max
      sync: 1, // boolean
    })
    const raw = readRawPatch(prog)
    expect(raw.octave).toBe(4)
    expect(raw.vco1Wave).toBe(2)
    expect(raw.cutoff).toBe(800)
    expect(raw.vco1Level).toBe(1023)
    expect(raw.sync).toBe(1)
  })

  it('clamps out-of-range values and defaults missing params to 0', () => {
    const prog = writeProgBin(template(), { cutoff: 99999, vco1_wave: 9 })
    const raw = readRawPatch(prog)
    expect(raw.cutoff).toBe(1023) // clamped to 10-bit max
    expect(raw.vco1Wave).toBe(2) // clamped to cardinality - 1
    expect(raw.resonance).toBe(0) // not supplied
  })
})

describe('readRawById', () => {
  it('round-trips writeProgBin by spec id (incl. voice_mode) — the "Mine\'s better" read', () => {
    const written = {
      voice_mode: 3, // UNISON
      cutoff: 700,
      vco1_wave: 2,
      amp_sustain: 0,
      portamento: 42, // 8-bit
    }
    const back = readRawById(writeProgBin(template(), written))
    expect(back.voice_mode).toBe(3)
    expect(back.cutoff).toBe(700)
    expect(back.vco1_wave).toBe(2)
    expect(back.amp_sustain).toBe(0)
    expect(back.portamento).toBe(42)
  })
})
