// Live panel mirror. Two layers feed the panel:
//   • program layer  — emitted as patch:load (file load OR SysEx dump), fanned
//     out to param:change by sections/shared. This is the loaded program value.
//   • live layer      — emitted here as param:live: the synth's ACTUAL current
//     control positions. Seeded from each dump (actual == program at that
//     instant) then updated per incoming Control Change as knobs move.
// Each CC writes one field of a mutable RawPatch and is run back through the
// existing parsePatch + PARAMS descriptors, so live edits render identically to
// a loaded file. CC map: minilogue xd MIDI Implementation Rev 1.01.

import { emit } from '../events/bus'
import { type RawPatch, readRawPatch } from '../parser/binary'
import { MULTI_ENGINE_COUNT, MULTI_TYPE } from '../parser/enums'
import { parsePatch } from '../parser/patch'
import { PARAMS, type ParamDescriptor } from '../sections/params'
import type { MinilogueXDPatch } from '../types/synth'

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

// Multi sub-type select (CC#103): the value range maps across the active
// engine's sub-types (NOISE has 4, VPM/USER 16). Drives the multi LCD label.
function applyMultiSelect(raw: RawPatch, v: number): void {
  const type = MULTI_TYPE[raw.multiType] ?? 'NOISE'
  const count = MULTI_ENGINE_COUNT[type]
  // Each sub-type owns a 128/count-wide band of the CC range. (round() over
  // count-1 collided 72 & 80 onto FAT2 and skipped CREEP for VPM's 16 types.)
  const index = Math.min(count - 1, Math.floor((v * count) / 128))
  if (type === 'VPM') raw.selectVPM = index
  else if (type === 'USER') raw.selectUser = index
  else raw.selectNoise = index
}

// Voice-mode selector and the deep VPM/USER params have no transmittable CC —
// they refresh from the SysEx snapshot, not live.
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

  // multi sub-type select (HIGH/LOW/… for NOISE; SIN1/… for VPM; slot for USER)
  103: {
    section: 'multi',
    key: 'typeValue',
    apply: (r, v) => {
      applyMultiSelect(r, v)
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

  // effects on/off
  92: {
    section: 'modFx',
    key: 'on',
    apply: (r, v) => {
      r.modFxOn = onOff(v)
    },
  },
  93: {
    section: 'delay',
    key: 'on',
    apply: (r, v) => {
      r.delayOn = onOff(v)
    },
  },
  94: {
    section: 'reverb',
    key: 'on',
    apply: (r, v) => {
      r.reverbOn = onOff(v)
    },
  },
}

export interface LivePatch {
  /** Load a SysEx dump into the program layer; seedLive also resets the live
      layer (connect/refresh). Pass false on a program change. */
  loadDump: (prog: Uint8Array, seedLive?: boolean) => void
  /** Apply one incoming Control Change; updates the live layer for one control. */
  controlChange: (cc: number, value: number) => void
  hasSnapshot: () => boolean
}

export function createLivePatch(): LivePatch {
  let raw: RawPatch | null = null
  let pendingLsb = 0

  function emitLive(d: ParamDescriptor, patch: MinilogueXDPatch): void {
    const value = d.value(patch)
    const display = d.display?.(patch)
    emit(
      'param:live',
      display === undefined
        ? { section: d.section, key: d.key, value }
        : { section: d.section, key: d.key, value, display },
    )
  }

  // seedLive: true on connect / manual Refresh, to establish the live baseline.
  // false on a program change — the physical knobs haven't moved, so the synth
  // (live) needles must stay put while only the program needles jump.
  function loadDump(prog: Uint8Array, seedLive = true): void {
    raw = readRawPatch(prog)
    const patch = parsePatch(raw)
    // Program layer (drives the existing fanout → param:change).
    emit('patch:load', { patch, index: 0, total: 1 })
    if (seedLive) for (const d of PARAMS) emitLive(d, patch)
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
    // The multi engine couples select/shape/type, so refresh the whole section;
    // otherwise emit only the control that changed.
    for (const d of PARAMS) {
      const match =
        spec.section === 'multi'
          ? d.section === 'multi'
          : d.section === spec.section && d.key === spec.key
      if (match) emitLive(d, patch)
    }
  }

  return { loadDump, controlChange, hasSnapshot: () => raw !== null }
}
