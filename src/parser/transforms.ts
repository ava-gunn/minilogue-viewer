// Raw (prog_bin) value → meaningful unit transforms. Formulas from the gekart
// gist, cross-checked against the oxur crate (see plan reference links).

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** 10-bit raw (0..1023) → normalized 0..1 control position. */
export const norm10 = (v: number): number => clamp01(v / 1023)

/** 7-bit raw (0..127) → normalized 0..1. */
export const norm7 = (v: number): number => clamp01(v / 127)

/**
 * VCO pitch raw (0..1023) → detune in cents (±1200), piecewise per the Korg
 * mapping. ~492..532 is the centered dead zone.
 */
export function pitchToCents(v: number): number {
  let cents: number
  if (v < 4) cents = -1200
  else if (v < 356) cents = ((v - 356) * 944) / 352 - 256
  else if (v < 476) cents = (v - 476) * 2 - 16
  else if (v < 492) cents = v - 492
  else if (v < 532) cents = 0
  else if (v < 548) cents = v - 532
  else if (v < 668) cents = (v - 548) * 2 + 16
  else if (v < 1020) cents = ((v - 668) * 944) / 352 + 256
  else cents = 1200
  return Math.round(cents)
}

/**
 * EG / LFO intensity raw (0..1023) → bipolar percent (-100..+100), quadratic
 * either side of the ~492..532 center. (LFO INT reuses this curve as an
 * approximation; the exact LFO curve is unconfirmed in the sources.)
 */
export function egIntToPercent(v: number): number {
  let pct: number
  if (v < 11) pct = -100
  else if (v < 492) pct = -(((492 - v) ** 2 * 4641 * 100) / 0x40000000)
  else if (v <= 532) pct = 0
  else if (v < 1013) pct = ((v - 532) ** 2 * 4641 * 100) / 0x40000000
  else pct = 100
  return Math.round(pct)
}

const LFO_BPM_DIVISIONS = [
  '4',
  '2',
  '1',
  '3/4',
  '1/2',
  '3/8',
  '1/3',
  '1/4',
  '3/16',
  '1/6',
  '1/8',
  '1/12',
  '1/16',
  '1/24',
  '1/32',
  '1/36',
] as const

/** LFO RATE raw (0..1023) → BPM-sync note division label (when mode = BPM). */
export function lfoRateDivision(v: number): string {
  return LFO_BPM_DIVISIONS[Math.min(Math.floor(v / 64), 15)] ?? '1/4'
}
