// Byte offsets and bit widths mirror the reader in ./binary.ts (enforced by
// schema-gen.test.ts via a round-trip); discrete value orderings are imported from
// ./enums.ts. `pnpm build:schema` serializes this to ../../schema/, consumed by both
// the browser inference layer and the Python trainer.
//
// modFxType (offset 89) is intentionally excluded — parsePatch ignores it, so it does
// not affect the reconstructed patch and has no UI to validate against.

import type { RawPatch } from './binary'
import {
  EG_TARGET,
  LFO_MODE,
  LFO_TARGET,
  MULTI_NOISE,
  MULTI_TYPE,
  MULTI_VPM,
  VCO_WAVE,
  VOICE_MODE,
} from './enums'

export type ParamType = 'continuous' | 'discrete' | 'boolean'

interface BaseSpec {
  /** Public snake_case id; the model output key. */
  id: string
  /** RawPatch field this maps to (inference assembles a RawPatch, then parsePatch). */
  field: keyof RawPatch
  /** Dotted path in MinilogueXDPatch — informational, for grouping/eval. */
  path: string
  /** Byte offset in the 1024-byte program data (== SysEx current-program-data offset). */
  offset: number
  bitWidth: 8 | 10
  category: string
}

export interface ContinuousSpec extends BaseSpec {
  type: 'continuous'
  rawMin: number
  rawMax: number
}

export interface DiscreteSpec extends BaseSpec {
  type: 'discrete'
  /** Number of softmax classes (== count of valid raw values). */
  cardinality: number
  /** Human labels per class, in raw-index order, when known. */
  values?: readonly string[]
}

export interface BooleanSpec extends BaseSpec {
  type: 'boolean'
}

export type ParamSpec = ContinuousSpec | DiscreteSpec | BooleanSpec

const cont = (
  id: string,
  field: keyof RawPatch,
  path: string,
  offset: number,
  bitWidth: 8 | 10,
  category: string,
): ContinuousSpec => ({
  type: 'continuous',
  id,
  field,
  path,
  offset,
  bitWidth,
  category,
  rawMin: 0,
  rawMax: bitWidth === 10 ? 1023 : 127,
})

// All discrete fields are single-byte (u8).
const disc = (
  id: string,
  field: keyof RawPatch,
  path: string,
  offset: number,
  category: string,
  values: readonly string[] | number,
): DiscreteSpec => {
  const base = {
    type: 'discrete' as const,
    id,
    field,
    path,
    offset,
    bitWidth: 8 as const,
    category,
    cardinality: typeof values === 'number' ? values : values.length,
  }
  return typeof values === 'number' ? base : { ...base, values }
}

const bool = (
  id: string,
  field: keyof RawPatch,
  path: string,
  offset: number,
  category: string,
): BooleanSpec => ({
  type: 'boolean',
  id,
  field,
  path,
  offset,
  bitWidth: 8,
  category,
})

const PERCENT3 = ['0%', '50%', '100%'] as const

export const PARAM_SPEC: readonly ParamSpec[] = [
  // VOICE
  disc('octave', 'octave', 'voice.octave', 16, 'voice', 5),
  cont('portamento', 'portamento', 'voice.portamento', 17, 8, 'voice'),
  cont(
    'voice_mode_depth',
    'voiceModeDepth',
    'voice.modeDepth',
    19,
    10,
    'voice',
  ),
  disc('voice_mode', 'voiceModeType', 'voice.mode', 21, 'voice', VOICE_MODE),

  // VCO 1
  disc('vco1_wave', 'vco1Wave', 'vco1.wave', 22, 'vco1', VCO_WAVE),
  disc('vco1_octave', 'vco1Octave', 'vco1.octave', 23, 'vco1', 4),
  cont('vco1_pitch', 'vco1Pitch', 'vco1.pitch', 24, 10, 'vco1'),
  cont('vco1_shape', 'vco1Shape', 'vco1.shape', 26, 10, 'vco1'),

  // VCO 2
  disc('vco2_wave', 'vco2Wave', 'vco2.wave', 28, 'vco2', VCO_WAVE),
  disc('vco2_octave', 'vco2Octave', 'vco2.octave', 29, 'vco2', 4),
  cont('vco2_pitch', 'vco2Pitch', 'vco2.pitch', 30, 10, 'vco2'),
  cont('vco2_shape', 'vco2Shape', 'vco2.shape', 32, 10, 'vco2'),
  bool('sync', 'sync', 'vco2.sync', 34, 'vco2'),
  bool('ring', 'ring', 'vco2.ring', 35, 'vco2'),
  cont(
    'cross_mod_depth',
    'crossModDepth',
    'vco2.crossModDepth',
    36,
    10,
    'vco2',
  ),

  // MULTI ENGINE (conditional sub-engine fields; parsePatch selects the active one)
  disc('multi_type', 'multiType', 'multi.type', 38, 'multi', MULTI_TYPE),
  disc(
    'multi_select_noise',
    'selectNoise',
    'multi.select.noise',
    39,
    'multi',
    MULTI_NOISE,
  ),
  disc(
    'multi_select_vpm',
    'selectVPM',
    'multi.select.vpm',
    40,
    'multi',
    MULTI_VPM,
  ),
  disc('multi_select_user', 'selectUser', 'multi.select.user', 41, 'multi', 16),
  cont('multi_shape_noise', 'shapeNoise', 'multi.shape.noise', 42, 10, 'multi'),
  cont('multi_shape_vpm', 'shapeVPM', 'multi.shape.vpm', 44, 10, 'multi'),
  cont('multi_shape_user', 'shapeUser', 'multi.shape.user', 46, 10, 'multi'),
  cont(
    'multi_shift_shape_noise',
    'shiftShapeNoise',
    'multi.shiftShape.noise',
    48,
    10,
    'multi',
  ),
  cont(
    'multi_shift_shape_vpm',
    'shiftShapeVPM',
    'multi.shiftShape.vpm',
    50,
    10,
    'multi',
  ),
  cont(
    'multi_shift_shape_user',
    'shiftShapeUser',
    'multi.shiftShape.user',
    52,
    10,
    'multi',
  ),

  // MIXER
  cont('mixer_vco1', 'vco1Level', 'mixer.vco1', 54, 10, 'mixer'),
  cont('mixer_vco2', 'vco2Level', 'mixer.vco2', 56, 10, 'mixer'),
  cont('mixer_multi', 'multiLevel', 'mixer.multi', 58, 10, 'mixer'),

  // FILTER
  cont('cutoff', 'cutoff', 'filter.cutoff', 60, 10, 'filter'),
  cont('resonance', 'resonance', 'filter.resonance', 62, 10, 'filter'),
  disc('filter_drive', 'cutoffDrive', 'filter.drive', 64, 'filter', PERCENT3),
  disc(
    'filter_key_track',
    'cutoffKeyTrack',
    'filter.keyTracking',
    65,
    'filter',
    PERCENT3,
  ),

  // AMP EG
  cont('amp_attack', 'ampAttack', 'ampEnv.attack', 66, 10, 'amp_eg'),
  cont('amp_decay', 'ampDecay', 'ampEnv.decay', 68, 10, 'amp_eg'),
  cont('amp_sustain', 'ampSustain', 'ampEnv.sustain', 70, 10, 'amp_eg'),
  cont('amp_release', 'ampRelease', 'ampEnv.release', 72, 10, 'amp_eg'),

  // FILTER EG
  cont('eg_attack', 'egAttack', 'filterEnv.attack', 74, 10, 'filter_eg'),
  cont('eg_decay', 'egDecay', 'filterEnv.decay', 76, 10, 'filter_eg'),
  cont('eg_int', 'egInt', 'filterEnv.int', 78, 10, 'filter_eg'),
  disc('eg_target', 'egTarget', 'filterEnv.target', 80, 'filter_eg', EG_TARGET),

  // LFO
  disc('lfo_wave', 'lfoWave', 'lfo.wave', 81, 'lfo', VCO_WAVE),
  disc('lfo_mode', 'lfoMode', 'lfo.mode', 82, 'lfo', LFO_MODE),
  cont('lfo_rate', 'lfoRate', 'lfo.rate', 83, 10, 'lfo'),
  cont('lfo_int', 'lfoInt', 'lfo.int', 85, 10, 'lfo'),
  disc('lfo_target', 'lfoTarget', 'lfo.target', 87, 'lfo', LFO_TARGET),

  // MOD FX
  bool('mod_fx_on', 'modFxOn', 'modFx.on', 88, 'mod_fx'),

  // DELAY
  bool('delay_on', 'delayOn', 'delay.on', 99, 'delay'),
  cont('delay_time', 'delayTime', 'delay.time', 101, 10, 'delay'),
  cont('delay_depth', 'delayDepth', 'delay.depth', 103, 10, 'delay'),

  // REVERB
  bool('reverb_on', 'reverbOn', 'reverb.on', 105, 'reverb'),
  cont('reverb_time', 'reverbTime', 'reverb.time', 107, 10, 'reverb'),
  cont('reverb_depth', 'reverbDepth', 'reverb.depth', 109, 10, 'reverb'),
]

export interface ParamRecord {
  id: string
  field: string
  path: string
  byte_offset: number
  bit_width: number
  type: ParamType
  category: string
  raw_min?: number
  raw_max?: number
  cardinality?: number
  values?: readonly string[]
}

export interface ParamsSchema {
  note: string
  count: number
  parameters: ParamRecord[]
}

export interface AudioSchema {
  note: string
  sample_rate: number
  duration_s: number
  pitch: string
  n_fft: number
  hop_length: number
  n_mels: number
  fmin: number
  fmax: number
  window: string
}

const GENERATED =
  'Generated from web/src/parser/param-spec.ts by `pnpm build:schema`. Do not edit by hand.'

const toRecord = (s: ParamSpec): ParamRecord => {
  const base = {
    id: s.id,
    field: s.field,
    path: s.path,
    byte_offset: s.offset,
    bit_width: s.bitWidth,
    type: s.type,
    category: s.category,
  }
  switch (s.type) {
    case 'continuous':
      return { ...base, raw_min: s.rawMin, raw_max: s.rawMax }
    case 'discrete':
      return s.values
        ? { ...base, cardinality: s.cardinality, values: s.values }
        : { ...base, cardinality: s.cardinality }
    case 'boolean':
      return base
  }
}

export function buildParamsSchema(): ParamsSchema {
  return {
    note: GENERATED,
    count: PARAM_SPEC.length,
    parameters: PARAM_SPEC.map(toRecord),
  }
}

// Shared by the browser inference layer and the Python trainer. Framing is
// center=False; n_frames is derived (see contract.ts / schema.py). Mel parity
// pinned by the golden-vector test.
export const AUDIO_SPEC = {
  sample_rate: 44100,
  duration_s: 1,
  pitch: 'C4',
  n_fft: 2048,
  hop_length: 512,
  n_mels: 128,
  fmin: 20,
  fmax: 22050,
  window: 'hann',
} as const

export function buildAudioSchema(): AudioSchema {
  return { note: GENERATED, ...AUDIO_SPEC }
}
