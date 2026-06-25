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

// Model outputs -> raw param values keyed by spec id (continuous denormalized, discrete
// argmaxed, boolean thresholded). The id-keyed form the Gemini path also uses, so the
// built-in model can feed the same rawByIdToPatch() display and contribution-upload path.
export function outputsToRawById(out: RawOutputs): Record<string, number> {
  const raw: Record<string, number> = {}

  continuousParams.forEach((p, i) => {
    raw[p.id] = clampRound(out.continuous[i] * p.rawMax, p.rawMin, p.rawMax)
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
    raw[p.id] = best
    offset += p.cardinality
  }

  booleanParams.forEach((p, i) => {
    raw[p.id] = out.boolean[i] >= 0.5 ? 1 : 0
  })

  return raw
}

// Same target as outputsToRawPatch, but fed raw param values keyed by spec id (what the
// Gemini path produces) instead of model head tensors: continuous already in raw space,
// discrete as a class index, boolean as 0/1. Mirrors outputsToRawPatch field-for-field so
// both inference paths reconstruct patches identically (modFxType excluded, as in the spec).
export function rawByIdToPatch(
  rawById: Record<string, number>,
  name = 'AI MATCH',
): MinilogueXDPatch {
  const raw = { name, modFxType: 0 } as unknown as RawPatch
  const fields = raw as unknown as Record<string, number | string>

  for (const p of continuousParams) {
    fields[p.field] = clampRound(rawById[p.id] ?? 0, p.rawMin, p.rawMax)
  }
  for (const p of discreteParams) {
    fields[p.field] = clampRound(rawById[p.id] ?? 0, 0, p.cardinality - 1)
  }
  for (const p of booleanParams) {
    fields[p.field] = rawById[p.id] ? 1 : 0
  }

  return parsePatch(raw)
}
