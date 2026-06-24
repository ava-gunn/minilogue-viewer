// Model outputs -> RawPatch -> MinilogueXDPatch. The model predicts in raw parameter
// space, so we assemble a RawPatch and hand it to the existing parsePatch(), reusing
// every transform curve (pitch->cents, egInt->bipolar, etc.) instead of duplicating them.

import type { RawPatch } from '../parser/binary'
import { parsePatch } from '../parser/patch'
import type { MinilogueXDPatch } from '../types/synth'
import { booleanParams, continuousParams, discreteParams } from './contract'
import type { RawOutputs } from './session'

const clampRound = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)))

export function outputsToRawPatch(out: RawOutputs): RawPatch {
  // Every numeric field is populated from the spec below; name + modFxType (excluded
  // from the spec) are set explicitly, so no RawPatch field is left undefined.
  const raw = { name: 'AI MATCH', modFxType: 0 } as unknown as RawPatch
  const fields = raw as unknown as Record<string, number | string>

  continuousParams.forEach((p, i) => {
    fields[p.field] = clampRound(
      out.continuous[i] * p.rawMax,
      p.rawMin,
      p.rawMax,
    )
  })

  let offset = 0
  for (const p of discreteParams) {
    let best = 0
    let bestVal = Number.NEGATIVE_INFINITY
    for (let k = 0; k < p.cardinality; k++) {
      const v = out.discrete[offset + k]
      if (v > bestVal) {
        bestVal = v
        best = k
      }
    }
    fields[p.field] = best
    offset += p.cardinality
  }

  booleanParams.forEach((p, i) => {
    fields[p.field] = out.boolean[i] >= 0.5 ? 1 : 0
  })

  return raw
}

export function outputsToPatch(out: RawOutputs): MinilogueXDPatch {
  return parsePatch(outputsToRawPatch(out))
}
