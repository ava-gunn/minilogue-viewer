// Mirrors training/xd_params.py `sample`: continuous params drawn within "audible"
// sub-ranges, discrete uniform over classes, booleans a coin flip, voice_mode pinned
// to POLY (never arpeggiates). Feed through writeProgBin() to load onto the synth.

import { PARAM_SPEC } from './param-spec'

// voice_mode raw 4 = POLY (raw 0 = ARP latch). See web/src/parser/enums.ts VOICE_MODE.
const VOICE_MODE_POLY = 4

// Audible sub-ranges mirrored from xd_params._BIAS; everything else spans [0, 1].
const BIAS: Record<string, [number, number]> = {
  mixer_vco1: [0.15, 1],
  mixer_vco2: [0.15, 1],
  mixer_multi: [0.15, 1],
  cutoff: [0.15, 1],
  amp_attack: [0, 0.7],
}

/** A random patch as raw values keyed by spec id. `rand` is injectable for deterministic tests. */
export function randomSweepRawById(
  rand: () => number = Math.random,
): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const p of PARAM_SPEC) {
    if (p.id === 'voice_mode') {
      raw[p.id] = VOICE_MODE_POLY
    } else if (p.type === 'continuous') {
      const [lo, hi] = BIAS[p.id] ?? [0, 1]
      raw[p.id] = Math.round((lo + rand() * (hi - lo)) * p.rawMax)
    } else if (p.type === 'discrete') {
      raw[p.id] = Math.min(
        p.cardinality - 1,
        Math.floor(rand() * p.cardinality),
      )
    } else {
      raw[p.id] = rand() < 0.5 ? 0 : 1
    }
  }
  return raw
}
