import type { RawPatch } from '../parser/binary'
import { parsePatch } from '../parser/patch'
import type { MinilogueXDPatch } from '../types/synth'
import { booleanParams, continuousParams, discreteParams } from './contract'
import type { RawOutputs } from './session'

const clampRound = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)))

export function outputsToRawPatch(out: RawOutputs): RawPatch {
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
