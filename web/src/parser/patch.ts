import type { MinilogueXDPatch, MultiType } from '../types/synth'
import type { RawPatch } from './binary'
import {
  EG_TARGET,
  LFO_MODE,
  LFO_TARGET,
  MULTI_ENGINE_COUNT,
  MULTI_NOISE,
  MULTI_TYPE,
  MULTI_VPM,
  VCO_WAVE,
  VOICE_MODE,
} from './enums'
import { clamp01, norm7, norm10 } from './transforms'

const at = <T>(table: readonly T[], i: number, fallback: T): T =>
  table[i] ?? fallback

const clampInt = (v: number, max: number): number =>
  Math.min(Math.max(Math.round(v), 0), max)

/** Pick the active multi engine's shape/shift/select/label. */
function multiEngine(raw: RawPatch, type: MultiType) {
  switch (type) {
    case 'VPM':
      return {
        shape: raw.shapeVPM,
        shiftShape: raw.shiftShapeVPM,
        select: raw.selectVPM,
        label: MULTI_VPM[raw.selectVPM] ?? `VPM ${raw.selectVPM + 1}`,
      }
    case 'USER':
      return {
        shape: raw.shapeUser,
        shiftShape: raw.shiftShapeUser,
        select: raw.selectUser,
        label: `USER ${raw.selectUser + 1}`,
      }
    default:
      return {
        shape: raw.shapeNoise,
        shiftShape: raw.shiftShapeNoise,
        select: raw.selectNoise,
        label: MULTI_NOISE[raw.selectNoise] ?? `NOISE ${raw.selectNoise + 1}`,
      }
  }
}

/** Map raw integer fields into the normalized domain patch. */
export function parsePatch(raw: RawPatch): MinilogueXDPatch {
  const multiType = at(MULTI_TYPE, raw.multiType, 'NOISE')
  const engine = multiEngine(raw, multiType)
  const subCount = MULTI_ENGINE_COUNT[multiType]

  return {
    name: raw.name,
    voice: {
      mode: at(VOICE_MODE, raw.voiceModeType, 'POLY'),
      modeDepth: norm10(raw.voiceModeDepth),
      portamento: norm7(raw.portamento),
      octave: raw.octave - 2,
    },
    vco1: {
      wave: at(VCO_WAVE, raw.vco1Wave, 'SQR'),
      octave: clampInt(raw.vco1Octave, 3),
      pitch: norm10(raw.vco1Pitch),
      shape: norm10(raw.vco1Shape),
    },
    vco2: {
      wave: at(VCO_WAVE, raw.vco2Wave, 'SQR'),
      octave: clampInt(raw.vco2Octave, 3),
      pitch: norm10(raw.vco2Pitch),
      shape: norm10(raw.vco2Shape),
      crossModDepth: norm10(raw.crossModDepth),
      sync: raw.sync !== 0,
      ring: raw.ring !== 0,
    },
    multi: {
      type: multiType,
      typeValue: subCount > 1 ? clamp01(engine.select / (subCount - 1)) : 0,
      typeLabel: engine.label,
      shape: norm10(engine.shape),
      shiftShape: norm10(engine.shiftShape),
    },
    mixer: {
      vco1: norm10(raw.vco1Level),
      vco2: norm10(raw.vco2Level),
      multi: norm10(raw.multiLevel),
    },
    filter: {
      cutoff: norm10(raw.cutoff),
      resonance: norm10(raw.resonance),
      drive: clampInt(raw.cutoffDrive, 2),
      keyTracking: clampInt(raw.cutoffKeyTrack, 2),
    },
    ampEnv: {
      attack: norm10(raw.ampAttack),
      decay: norm10(raw.ampDecay),
      sustain: norm10(raw.ampSustain),
      release: norm10(raw.ampRelease),
    },
    filterEnv: {
      attack: norm10(raw.egAttack),
      decay: norm10(raw.egDecay),
      int: norm10(raw.egInt),
      target: at(EG_TARGET, raw.egTarget, 'CUTOFF'),
    },
    lfo: {
      wave: at(VCO_WAVE, raw.lfoWave, 'SQR'),
      mode: at(LFO_MODE, raw.lfoMode, 'NORMAL'),
      rate: norm10(raw.lfoRate),
      int: norm10(raw.lfoInt),
      target: at(LFO_TARGET, raw.lfoTarget, 'CUTOFF'),
    },
    modFx: {
      on: raw.modFxOn !== 0,
      time: norm10(raw.modFxTime),
      depth: norm10(raw.modFxDepth),
    },
    delay: {
      on: raw.delayOn !== 0,
      time: norm10(raw.delayTime),
      depth: norm10(raw.delayDepth),
    },
    reverb: {
      on: raw.reverbOn !== 0,
      time: norm10(raw.reverbTime),
      depth: norm10(raw.reverbDepth),
    },
  }
}
