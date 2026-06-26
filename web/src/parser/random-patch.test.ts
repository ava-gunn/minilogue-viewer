import { describe, expect, it } from 'vitest'

import type { ContinuousSpec } from './param-spec'
import { PARAM_SPEC } from './param-spec'
import { randomSweepRawById } from './random-patch'

// Deterministic generator so tests don't depend on Math.random.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const continuous = (id: string): ContinuousSpec => {
  const p = PARAM_SPEC.find((s) => s.id === id)
  if (p?.type !== 'continuous') throw new Error(`no continuous param: ${id}`)
  return p
}

describe('randomSweepRawById', () => {
  it('always pins voice_mode to POLY (4), never the arp/latch values', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomSweepRawById(lcg(i)).voice_mode).toBe(4)
    }
  })

  it('keeps every param within its schema range', () => {
    const rand = lcg(42)
    for (let i = 0; i < 100; i++) {
      const raw = randomSweepRawById(rand)
      for (const p of PARAM_SPEC) {
        const v = raw[p.id]
        expect(Number.isInteger(v)).toBe(true)
        if (p.type === 'continuous') {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(p.rawMax)
        } else if (p.type === 'discrete') {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThan(p.cardinality)
        } else {
          expect([0, 1]).toContain(v)
        }
      }
    }
  })

  it('confines biased params to their audible sub-range', () => {
    // rand()=0 -> low edge of the range, rand()≈1 -> high edge.
    const lo = randomSweepRawById(() => 0)
    const hi = randomSweepRawById(() => 1 - 1e-9)
    expect(lo.mixer_vco1).toBe(
      Math.round(0.15 * continuous('mixer_vco1').rawMax),
    )
    expect(lo.cutoff).toBe(Math.round(0.15 * continuous('cutoff').rawMax))
    expect(lo.amp_attack).toBe(0)
    expect(hi.amp_attack).toBeLessThanOrEqual(
      Math.round(0.7 * continuous('amp_attack').rawMax),
    )
  })

  it('is deterministic given the same rng sequence', () => {
    expect(randomSweepRawById(lcg(7))).toEqual(randomSweepRawById(lcg(7)))
  })
})
