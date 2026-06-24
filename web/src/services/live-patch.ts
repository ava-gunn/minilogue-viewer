// Live panel mirror: translate the Control Change stream the minilogue xd sends
// when its knobs/switches move into single-control updates. Each CC writes one
// field of a mutable RawPatch (seeded by the last SysEx snapshot), which is then
// run back through the existing parsePatch + PARAMS descriptors — so live edits
// render byte-identically to a loaded file. CC map: minilogue xd MIDI Impl 1.01.

import { emit } from '../events/bus'
import { type RawPatch, readRawPatch } from '../parser/binary'
import { MULTI_TYPE } from '../parser/enums'
import { parsePatch } from '../parser/patch'
import { PARAMS } from '../sections/params'

/** CC#63 carries the low 3 bits of a 10-bit value, sent just before its own CC. */
const CC_LSB = 63

// Continuous 10-bit: own CC = high 7 bits, preceding CC#63 = low 3 bits.
const tenBit = (msb: number, lsb: number): number => (msb << 3) | (lsb & 0x07)
// Three-position selectors transmit 0 / 64 / 127 → index 0 / 1 / 2.
const enum3 = (v: number): number => (v < 32 ? 0 : v < 96 ? 1 : 2)
// Four-position octave switch transmits 0 / 42 / 84 / 127 → 0..3.
const octave4 = (v: number): number => Math.min(3, Math.round((v / 127) * 3))
// On/off switches transmit 0 / 127.
const onOff = (v: number): number => (v >= 64 ? 1 : 0)

interface CcSpec {
  section: string
  key: string
  /** msb = the parameter CC value (0..127); lsb = low 3 bits from a prior CC#63. */
  apply: (raw: RawPatch, msb: number, lsb: number) => void
}

function applyMultiShape(raw: RawPatch, value: number): void {
  const type = MULTI_TYPE[raw.multiType] ?? 'NOISE'
  if (type === 'VPM') raw.shapeVPM = value
  else if (type === 'USER') raw.shapeUser = value
  else raw.shapeNoise = value
}

// Voice-mode selector, multi sub-type and the deep VPM/USER params have no
// transmittable CC — they refresh from the SysEx snapshot, not live.
const CC_TABLE: Record<number, CcSpec> = {
  // continuous 10-bit
  16: {
    section: 'ampEnv',
    key: 'attack',
    apply: (r, m, l) => {
      r.ampAttack = tenBit(m, l)
    },
  },
  17: {
    section: 'ampEnv',
    key: 'decay',
    apply: (r, m, l) => {
      r.ampDecay = tenBit(m, l)
    },
  },
  18: {
    section: 'ampEnv',
    key: 'sustain',
    apply: (r, m, l) => {
      r.ampSustain = tenBit(m, l)
    },
  },
  19: {
    section: 'ampEnv',
    key: 'release',
    apply: (r, m, l) => {
      r.ampRelease = tenBit(m, l)
    },
  },
  20: {
    section: 'filterEnv',
    key: 'attack',
    apply: (r, m, l) => {
      r.egAttack = tenBit(m, l)
    },
  },
  21: {
    section: 'filterEnv',
    key: 'decay',
    apply: (r, m, l) => {
      r.egDecay = tenBit(m, l)
    },
  },
  22: {
    section: 'filterEnv',
    key: 'int',
    apply: (r, m, l) => {
      r.egInt = tenBit(m, l)
    },
  },
  24: {
    section: 'lfo',
    key: 'rate',
    apply: (r, m, l) => {
      r.lfoRate = tenBit(m, l)
    },
  },
  26: {
    section: 'lfo',
    key: 'int',
    apply: (r, m, l) => {
      r.lfoInt = tenBit(m, l)
    },
  },
  27: {
    section: 'voice',
    key: 'modeDepth',
    apply: (r, m, l) => {
      r.voiceModeDepth = tenBit(m, l)
    },
  },
  33: {
    section: 'mixer',
    key: 'multi',
    apply: (r, m, l) => {
      r.multiLevel = tenBit(m, l)
    },
  },
  34: {
    section: 'vco1',
    key: 'pitch',
    apply: (r, m, l) => {
      r.vco1Pitch = tenBit(m, l)
    },
  },
  35: {
    section: 'vco2',
    key: 'pitch',
    apply: (r, m, l) => {
      r.vco2Pitch = tenBit(m, l)
    },
  },
  36: {
    section: 'vco1',
    key: 'shape',
    apply: (r, m, l) => {
      r.vco1Shape = tenBit(m, l)
    },
  },
  37: {
    section: 'vco2',
    key: 'shape',
    apply: (r, m, l) => {
      r.vco2Shape = tenBit(m, l)
    },
  },
  39: {
    section: 'mixer',
    key: 'vco1',
    apply: (r, m, l) => {
      r.vco1Level = tenBit(m, l)
    },
  },
  40: {
    section: 'mixer',
    key: 'vco2',
    apply: (r, m, l) => {
      r.vco2Level = tenBit(m, l)
    },
  },
  41: {
    section: 'vco2',
    key: 'crossModDepth',
    apply: (r, m, l) => {
      r.crossModDepth = tenBit(m, l)
    },
  },
  43: {
    section: 'filter',
    key: 'cutoff',
    apply: (r, m, l) => {
      r.cutoff = tenBit(m, l)
    },
  },
  44: {
    section: 'filter',
    key: 'resonance',
    apply: (r, m, l) => {
      r.resonance = tenBit(m, l)
    },
  },
  54: {
    section: 'multi',
    key: 'shape',
    apply: (r, m, l) => {
      applyMultiShape(r, tenBit(m, l))
    },
  },
  108: {
    section: 'reverb',
    key: 'time',
    apply: (r, m, l) => {
      r.reverbTime = tenBit(m, l)
    },
  },
  109: {
    section: 'reverb',
    key: 'depth',
    apply: (r, m, l) => {
      r.reverbDepth = tenBit(m, l)
    },
  },

  // 7-bit continuous (no LSB companion)
  5: {
    section: 'voice',
    key: 'portamento',
    apply: (r, m) => {
      r.portamento = m
    },
  },

  // enum / switch — snap to the transmitted breakpoints
  23: {
    section: 'filterEnv',
    key: 'target',
    apply: (r, v) => {
      r.egTarget = enum3(v)
    },
  },
  48: {
    section: 'vco1',
    key: 'octave',
    apply: (r, v) => {
      r.vco1Octave = octave4(v)
    },
  },
  49: {
    section: 'vco2',
    key: 'octave',
    apply: (r, v) => {
      r.vco2Octave = octave4(v)
    },
  },
  50: {
    section: 'vco1',
    key: 'wave',
    apply: (r, v) => {
      r.vco1Wave = enum3(v)
    },
  },
  51: {
    section: 'vco2',
    key: 'wave',
    apply: (r, v) => {
      r.vco2Wave = enum3(v)
    },
  },
  53: {
    section: 'multi',
    key: 'type',
    apply: (r, v) => {
      r.multiType = enum3(v)
    },
  },
  56: {
    section: 'lfo',
    key: 'target',
    apply: (r, v) => {
      r.lfoTarget = enum3(v)
    },
  },
  57: {
    section: 'lfo',
    key: 'wave',
    apply: (r, v) => {
      r.lfoWave = enum3(v)
    },
  },
  58: {
    section: 'lfo',
    key: 'mode',
    apply: (r, v) => {
      r.lfoMode = enum3(v)
    },
  },
  80: {
    section: 'vco2',
    key: 'sync',
    apply: (r, v) => {
      r.sync = onOff(v)
    },
  },
  81: {
    section: 'vco2',
    key: 'ring',
    apply: (r, v) => {
      r.ring = onOff(v)
    },
  },
  83: {
    section: 'filter',
    key: 'keyTracking',
    apply: (r, v) => {
      r.cutoffKeyTrack = enum3(v)
    },
  },
  84: {
    section: 'filter',
    key: 'drive',
    apply: (r, v) => {
      r.cutoffDrive = enum3(v)
    },
  },
}

export interface LivePatch {
  /** Seed the live model from a full SysEx program dump and render the panel. */
  loadDump: (prog: Uint8Array) => void
  /** Apply one incoming Control Change; updates a single control if mapped. */
  controlChange: (cc: number, value: number) => void
  hasSnapshot: () => boolean
}

export function createLivePatch(): LivePatch {
  let raw: RawPatch | null = null
  let pendingLsb = 0

  function loadDump(prog: Uint8Array): void {
    raw = readRawPatch(prog)
    emit('patch:load', { patch: parsePatch(raw), index: 0, total: 1 })
  }

  function controlChange(cc: number, value: number): void {
    if (cc === CC_LSB) {
      pendingLsb = value & 0x07
      return
    }
    const spec = CC_TABLE[cc]
    const lsb = pendingLsb
    pendingLsb = 0
    // Ignore CCs until a snapshot establishes the full program state.
    if (!spec || !raw) return

    spec.apply(raw, value, lsb)
    const patch = parsePatch(raw)
    for (const d of PARAMS) {
      if (d.section !== spec.section || d.key !== spec.key) continue
      const v = d.value(patch)
      const display = d.display?.(patch)
      emit(
        'param:change',
        display === undefined
          ? { section: d.section, key: d.key, value: v }
          : { section: d.section, key: d.key, value: v, display },
      )
    }
  }

  return { loadDump, controlChange, hasSnapshot: () => raw !== null }
}
