import { describe, expect, it } from 'vitest'
import {
  booleanParams,
  continuousParams,
  discreteParams,
  TOTAL_DISCRETE,
} from './contract'
import { outputsToPatch, outputsToRawPatch } from './decode'
import type { RawOutputs } from './session'

const make = (): RawOutputs => ({
  continuous: new Float32Array(continuousParams.length),
  discrete: new Float32Array(TOTAL_DISCRETE),
  boolean: new Float32Array(booleanParams.length),
})

const contIndex = (id: string): number =>
  continuousParams.findIndex((p) => p.id === id)
const boolIndex = (id: string): number =>
  booleanParams.findIndex((p) => p.id === id)
const discOffset = (id: string): number => {
  let offset = 0
  for (const p of discreteParams) {
    if (p.id === id) return offset
    offset += p.cardinality
  }
  throw new Error(`no discrete param ${id}`)
}

describe('outputsToRawPatch', () => {
  it('denormalizes continuous params to their raw range', () => {
    const out = make()
    out.continuous[contIndex('cutoff')] = 0.5
    out.continuous[contIndex('portamento')] = 1
    const raw = outputsToRawPatch(out)
    expect(raw.cutoff).toBe(512) // round(0.5 * 1023)
    expect(raw.portamento).toBe(127) // 7-bit max
  })

  it('argmaxes each discrete group independently', () => {
    const out = make()
    out.discrete[discOffset('vco1_wave') + 2] = 1 // SAW
    out.discrete[discOffset('lfo_mode') + 1] = 1 // NORMAL
    const raw = outputsToRawPatch(out)
    expect(raw.vco1Wave).toBe(2)
    expect(raw.lfoMode).toBe(1)
  })

  it('thresholds boolean params at 0.5', () => {
    const out = make()
    out.boolean[boolIndex('sync')] = 0.9
    out.boolean[boolIndex('ring')] = 0.4
    const raw = outputsToRawPatch(out)
    expect(raw.sync).toBe(1)
    expect(raw.ring).toBe(0)
  })
})

describe('outputsToPatch', () => {
  it('runs the full output through parsePatch into a domain patch', () => {
    const patch = outputsToPatch(make())
    expect(patch.filter.cutoff).toBe(0)
    expect(patch.vco1.wave).toBe('SQR') // argmax of an all-zero group -> index 0
    expect(typeof patch.name).toBe('string')
  })
})
