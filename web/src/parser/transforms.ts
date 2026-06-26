// Formulas from the gekart gist, cross-checked against the oxur crate.

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** 10-bit raw (0..1023) → normalized 0..1 control position. */
export const norm10 = (v: number): number => clamp01(v / 1023)

/** 7-bit raw (0..127) → normalized 0..1. */
export const norm7 = (v: number): number => clamp01(v / 127)

// VCO pitch raw → cents, positive half (mirrored for the negative side),
// calibrated against the panel display. Korg's published MIDI table reads sharp
// in the upper octave (e.g. raw 861 → 774¢ vs the device's 710¢); these match the device.
const PITCH_CURVE: ReadonlyArray<readonly [number, number]> = [
  [512, 0],
  [536, 2],
  [547, 7],
  [660, 93],
  [697, 185],
  [754, 372],
  [825, 588],
  [861, 710],
  [958, 1004],
  [1023, 1200],
]

/** VCO pitch raw (0..1023) → detune in cents (±1200), symmetric about 512. */
export function pitchToCents(v: number): number {
  const raw = Math.min(1023, Math.max(0, Math.round(v)))
  const sign = raw < 512 ? -1 : 1
  const up = raw < 512 ? 1024 - raw : raw // fold onto the positive half
  let cents = 1200
  for (let i = 1; i < PITCH_CURVE.length; i++) {
    const [r1, c1] = PITCH_CURVE[i] as [number, number]
    if (up <= r1) {
      const [r0, c0] = PITCH_CURVE[i - 1] as [number, number]
      cents = c0 + ((c1 - c0) * (up - r0)) / (r1 - r0)
      break
    }
  }
  return Math.round(sign * cents)
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
