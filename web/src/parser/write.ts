// Write raw param values (by spec id) into a template prog_bin — the inverse of
// readRawPatch / binary.ts, mirroring training/xd_params.py write_params. Used to load a
// generated patch onto the hardware: overwrite only the param-region bytes of a valid
// 1024-byte program, leaving header / name / sequence intact.

import { PARAM_SPEC } from './param-spec'

const clampRound = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)))

function writeRaw(
  buf: Uint8Array,
  offset: number,
  width: 8 | 10,
  value: number,
): void {
  if (width === 8) {
    buf[offset] = value & 0xff
  } else {
    // 10-bit little-endian; preserve the unused high bits of the second byte.
    buf[offset] = value & 0xff
    buf[offset + 1] = (buf[offset + 1] & 0xfc) | ((value >> 8) & 0x03)
  }
}

export function writeProgBin(
  template: Uint8Array,
  rawById: Record<string, number>,
): Uint8Array {
  const buf = new Uint8Array(template) // copy — don't mutate the template
  for (const p of PARAM_SPEC) {
    const max =
      p.type === 'continuous'
        ? p.rawMax
        : p.type === 'discrete'
          ? p.cardinality - 1
          : 1
    writeRaw(buf, p.offset, p.bitWidth, clampRound(rawById[p.id] ?? 0, 0, max))
  }
  return buf
}
