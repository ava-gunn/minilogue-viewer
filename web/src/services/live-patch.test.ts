import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { on } from '../events/bus'
import type { ParamChange } from '../events/types'
import { extractProgramBins } from '../parser/unzip'
import { createLivePatch } from './live-patch'

const progBin = extractProgramBins(
  new Uint8Array(
    readFileSync(join(process.cwd(), 'replicant-example.mnlgxdprog')),
  ),
)[0]

describe('createLivePatch', () => {
  let changes: ParamChange[]
  let off: () => void

  beforeEach(() => {
    changes = []
    off = on('param:change', (c) => changes.push(c))
  })
  afterEach(() => off())

  const last = (section: string, key: string): ParamChange | undefined =>
    changes.filter((c) => c.section === section && c.key === key).at(-1)

  it('ignores Control Change until a snapshot is loaded', () => {
    const live = createLivePatch()
    live.controlChange(43, 100)
    expect(changes).toHaveLength(0)
    expect(live.hasSnapshot()).toBe(false)
  })

  it('mirrors a 10-bit continuous CC (cutoff) using the CC#63 LSB', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    live.controlChange(63, 7) // LSB (low 3 bits)
    live.controlChange(43, 127) // cutoff MSB → (127<<3)|7 = 1023
    expect(last('filter', 'cutoff')?.value).toBeCloseTo(1, 5)

    live.controlChange(43, 0) // no preceding LSB → 0
    expect(last('filter', 'cutoff')?.value).toBe(0)
  })

  it('maps a wave-selector CC to the right enum index', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    live.controlChange(50, 127) // VCO1 wave → SAW (index 2)
    expect(last('vco1', 'wave')?.value).toBe(2)
    live.controlChange(50, 0) // → SQR (index 0)
    expect(last('vco1', 'wave')?.value).toBe(0)
  })

  it('snaps the four-position octave switch', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    live.controlChange(48, 84) // VCO1 octave 0/42/84/127 → index 2 (4′)
    expect(last('vco1', 'octave')?.value).toBe(2)
  })

  it('emits only the control that changed', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    changes.length = 0
    live.controlChange(43, 64) // cutoff only
    expect(
      changes.every((c) => c.section === 'filter' && c.key === 'cutoff'),
    ).toBe(true)
    expect(changes.length).toBeGreaterThan(0)
  })
})
