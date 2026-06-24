import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProgramBin } from './index'
import {
  currentProgramDumpRequest,
  decodeCurrentProgramDump,
  isCurrentProgramDump,
  korgDecode7to8,
  korgEncode8to7,
} from './korg-sysex'
import { extractProgramBins } from './unzip'

// Vitest runs with cwd = project root, where the sample files live.
const progBin = extractProgramBins(
  new Uint8Array(
    readFileSync(join(process.cwd(), 'replicant-example.mnlgxdprog')),
  ),
)[0]

/** Build a synthetic CURRENT PROGRAM DATA DUMP from a raw prog_bin. */
const dumpMessage = (prog: Uint8Array, channel = 0): Uint8Array =>
  new Uint8Array([
    0xf0,
    0x42,
    0x30 | channel,
    0x00,
    0x01,
    0x51,
    0x40,
    ...korgEncode8to7(prog),
    0xf7,
  ])

describe('korg 7-bit packing', () => {
  it('round-trips arbitrary bytes', () => {
    const raw = new Uint8Array([
      0x50, 0x52, 0x4f, 0x47, 0x00, 0xff, 0x80, 0x7f, 0x01,
    ])
    expect(Array.from(korgDecode7to8(korgEncode8to7(raw)))).toEqual(
      Array.from(raw),
    )
  })

  it('encodes 1024 bytes to 1171 packed bytes', () => {
    expect(korgEncode8to7(new Uint8Array(1024))).toHaveLength(1171)
  })

  it('rides high bits in the leading msbits byte, LSB-first', () => {
    // first byte 0x80 (high bit set) → bit0 of msbits; second 0x01 → no high bit.
    expect(Array.from(korgEncode8to7(new Uint8Array([0x80, 0x01])))).toEqual([
      0b0000_0001, 0x00, 0x01,
    ])
  })
})

describe('current program dump request', () => {
  it('is the documented 8-byte message', () => {
    expect(Array.from(currentProgramDumpRequest(0))).toEqual([
      0xf0, 0x42, 0x30, 0x00, 0x01, 0x51, 0x10, 0xf7,
    ])
  })

  it('embeds the channel in the low nibble', () => {
    expect(currentProgramDumpRequest(5)[2]).toBe(0x35)
  })
})

describe('decodeCurrentProgramDump', () => {
  const msg = dumpMessage(progBin)

  it('recognizes the dump header on any channel', () => {
    expect(isCurrentProgramDump(msg)).toBe(true)
    expect(isCurrentProgramDump(dumpMessage(progBin, 9))).toBe(true)
    expect(isCurrentProgramDump(currentProgramDumpRequest(0))).toBe(false)
  })

  it('reconstructs the original 1024-byte prog_bin', () => {
    const decoded = decodeCurrentProgramDump(msg)
    expect(decoded).toHaveLength(1024)
    expect(Array.from(decoded)).toEqual(Array.from(progBin))
  })

  it('parses to the same patch as the file does', () => {
    const fromDump = parseProgramBin(decodeCurrentProgramDump(msg))
    expect(fromDump).toEqual(parseProgramBin(progBin))
    expect(fromDump.name).toBe('Replicant xd')
  })

  it('rejects non-dump messages', () => {
    expect(() =>
      decodeCurrentProgramDump(currentProgramDumpRequest(0)),
    ).toThrow()
  })
})
