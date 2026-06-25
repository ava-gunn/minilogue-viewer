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
    off = on('param:live', (c) => changes.push(c))
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

  it('leaves the live layer untouched on a program-change dump', () => {
    const live = createLivePatch()
    live.loadDump(progBin, false) // seedLive = false (program change)
    expect(changes).toHaveLength(0) // no param:live emitted
    expect(live.hasSnapshot()).toBe(true) // but the program raw is updated
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

  it('maps VPM sub-type CC#103 to distinct indices (no FAT2 dup, CREEP reachable)', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    live.controlChange(53, 64) // multi type → VPM (16 sub-types)
    live.controlChange(103, 72)
    expect(last('multi', 'typeValue')?.display).toBe('FAT2')
    live.controlChange(103, 80)
    expect(last('multi', 'typeValue')?.display).toBe('AIR1') // not a 2nd FAT2
    live.controlChange(103, 112)
    expect(last('multi', 'typeValue')?.display).toBe('CREEP')
  })

  it('mirrors voice mode type via CC#52', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    live.controlChange(52, 32) // → UNISON
    expect(last('voice', 'mode')?.value).toBe(1)
    live.controlChange(52, 64) // → CHORD
    expect(last('voice', 'mode')?.value).toBe(2)
    live.controlChange(52, 96) // → ARP
    expect(last('voice', 'mode')?.value).toBe(3)
  })

  it('reflects effect on/off via CC92/93/94', () => {
    const live = createLivePatch()
    live.loadDump(progBin)
    live.controlChange(94, 0)
    expect(last('reverb', 'on')?.value).toBe(0)
    live.controlChange(94, 127)
    expect(last('reverb', 'on')?.value).toBe(1)
    live.controlChange(92, 127)
    expect(last('modFx', 'on')?.value).toBe(1)
  })
})
