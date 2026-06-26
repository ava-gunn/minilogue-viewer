// Protocol: minilogue xd MIDI Implementation Rev 1.01.
//   Request : F0 42 3g 00 01 51 10 F7                     (g = global MIDI ch)
//   Response: F0 42 3g 00 01 51 40 <1171 packed bytes> F7 (1179 total)

const SYSEX_START = 0xf0
const SYSEX_END = 0xf7
const KORG_ID = 0x42
const FORMAT_HI = 0x30 // 0x3g: high nibble = format ID, low nibble = MIDI channel
const MODEL_ID = [0x00, 0x01, 0x51] as const
const FUNC_DUMP_REQUEST = 0x10
const FUNC_DUMP = 0x40

const PROG_BIN_SIZE = 1024
const PROG_MAGIC = [0x50, 0x52, 0x4f, 0x47] as const // "PROG"

/** Korg 7-bit→8-bit unpack. Each group is [msbits, b0..b6]; bit i of msbits is
    the high bit of the i-th following byte (LSB-first). */
export function korgDecode7to8(packed: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let pos = 0; pos < packed.length; ) {
    const msbits = packed[pos++]
    for (let i = 0; i < 7 && pos < packed.length; i++, pos++) {
      out.push((packed[pos] & 0x7f) | (((msbits >> i) & 1) << 7))
    }
  }
  return new Uint8Array(out)
}

/** Inverse of korgDecode7to8 (used for tests / round-tripping). */
export function korgEncode8to7(raw: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let pos = 0; pos < raw.length; pos += 7) {
    const group = raw.subarray(pos, pos + 7)
    let msbits = 0
    for (let i = 0; i < group.length; i++) msbits |= ((group[i] >> 7) & 1) << i
    out.push(msbits)
    for (let i = 0; i < group.length; i++) out.push(group[i] & 0x7f)
  }
  return new Uint8Array(out)
}

/** Bytes requesting the current program. The synth only answers on its global
    MIDI channel; channel is 0–15 (g=0 is channel 1). */
export function currentProgramDumpRequest(channel = 0): Uint8Array {
  return new Uint8Array([
    SYSEX_START,
    KORG_ID,
    FORMAT_HI | (channel & 0x0f),
    ...MODEL_ID,
    FUNC_DUMP_REQUEST,
    SYSEX_END,
  ])
}

/** CURRENT PROGRAM DATA DUMP: F0 42 3g 00 01 51 40 <7-bit packed prog> F7.
    Matches korg.program_dump in the trainer. */
export function currentProgramDump(prog: Uint8Array, channel = 0): Uint8Array {
  return new Uint8Array([
    SYSEX_START,
    KORG_ID,
    FORMAT_HI | (channel & 0x0f),
    ...MODEL_ID,
    FUNC_DUMP,
    ...korgEncode8to7(prog),
    SYSEX_END,
  ])
}

/** True if msg is a minilogue xd CURRENT PROGRAM DATA DUMP (any channel). */
export function isCurrentProgramDump(msg: Uint8Array): boolean {
  return (
    msg.length > 8 &&
    msg[0] === SYSEX_START &&
    msg[1] === KORG_ID &&
    (msg[2] & 0xf0) === FORMAT_HI &&
    msg[3] === MODEL_ID[0] &&
    msg[4] === MODEL_ID[1] &&
    msg[5] === MODEL_ID[2] &&
    msg[6] === FUNC_DUMP
  )
}

/** Decode a CURRENT PROGRAM DATA DUMP message into the 1024-byte prog_bin. */
export function decodeCurrentProgramDump(msg: Uint8Array): Uint8Array {
  if (!isCurrentProgramDump(msg)) {
    throw new Error('not a minilogue xd current-program dump')
  }
  const end = msg[msg.length - 1] === SYSEX_END ? msg.length - 1 : msg.length
  const decoded = korgDecode7to8(msg.subarray(7, end))
  if (decoded.length < PROG_BIN_SIZE) {
    throw new Error(`decoded dump too short: ${decoded.length} bytes`)
  }
  const prog = decoded.slice(0, PROG_BIN_SIZE)
  if (!PROG_MAGIC.every((b, i) => prog[i] === b)) {
    throw new Error('decoded dump missing PROG magic')
  }
  return prog
}
