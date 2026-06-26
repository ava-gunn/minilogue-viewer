// Continuous knob fields are normalized 0..1 control positions; display strings are derived from them.

export type Wave = 'SQR' | 'TRI' | 'SAW'

export type VoiceMode = 'POLY' | 'UNISON' | 'CHORD' | 'ARP'

export type MultiType = 'NOISE' | 'VPM' | 'USER'

export type LfoMode = 'BPM' | 'NORMAL' | '1-SHOT'

export type FilterEgTarget = 'PITCH' | 'PITCH2' | 'CUTOFF'

export type LfoTarget = 'PITCH' | 'SHAPE' | 'CUTOFF'

export interface VoiceParams {
  mode: VoiceMode
  modeDepth: number
  portamento: number
  /** Program octave shift, -2..+2. */
  octave: number
}

export interface OscParams {
  wave: Wave
  /** Octave foot index 0..3 → 16'/8'/4'/2'. */
  octave: number
  /** 0..1 position; display in cents. */
  pitch: number
  shape: number
}

export interface Vco2Params extends OscParams {
  crossModDepth: number
  sync: boolean
  ring: boolean
}

export interface MultiParams {
  type: MultiType
  /** 0..1 position of the active engine's sub-type selector. */
  typeValue: number
  /** Active engine sub-type name, shown on the multi LCD (e.g. "HIGH"). */
  typeLabel: string
  shape: number
  shiftShape: number
}

export interface MixerParams {
  vco1: number
  vco2: number
  multi: number
}

export interface FilterParams {
  cutoff: number
  resonance: number
  /** 0..2 → 0%/50%/100%. */
  drive: number
  /** 0..2 → 0%/50%/100%. */
  keyTracking: number
}

export interface AmpEgParams {
  attack: number
  decay: number
  sustain: number
  release: number
}

export interface FilterEgParams {
  attack: number
  decay: number
  /** 0..1 position; bipolar (0.5 = center), display ±%. */
  int: number
  target: FilterEgTarget
}

export interface LfoParams {
  wave: Wave
  mode: LfoMode
  rate: number
  /** 0..1 position; bipolar (0.5 = center), display ±%. */
  int: number
  target: LfoTarget
}

export interface FxSlot {
  on: boolean
  time: number
  depth: number
}

export interface MinilogueXDPatch {
  /** Program name (max 12 chars on hardware). */
  name: string
  voice: VoiceParams
  vco1: OscParams
  vco2: Vco2Params
  multi: MultiParams
  mixer: MixerParams
  filter: FilterParams
  ampEnv: AmpEgParams
  filterEnv: FilterEgParams
  lfo: LfoParams
  modFx: FxSlot
  delay: FxSlot
  reverb: FxSlot
}
