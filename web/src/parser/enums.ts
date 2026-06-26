// Indexed by the raw byte value. Sources: gekart gist + oxur crate.

import type {
  FilterEgTarget,
  LfoMode,
  LfoTarget,
  MultiType,
  VoiceMode,
  Wave,
} from '../types/synth'

/** VCO1 @22, VCO2 @28, LFO @81. */
export const VCO_WAVE: readonly Wave[] = ['SQR', 'TRI', 'SAW']

/** MULTI TYPE @38. */
export const MULTI_TYPE: readonly MultiType[] = ['NOISE', 'VPM', 'USER']

/** VOICE MODE TYPE @21 (Korg MIDI Impl): 0=ARP LATCH, 1=ARP, 2=CHORD, 3=UNISON, 4=POLY.
 *  POLY is 4 (not 0); index 0 is the latched arpeggiator. Latch collapses to ARP here. */
export const VOICE_MODE: readonly VoiceMode[] = [
  'ARP',
  'ARP',
  'CHORD',
  'UNISON',
  'POLY',
]

/** LFO MODE @82: 0=1-SHOT,1=NORMAL,2=BPM. */
export const LFO_MODE: readonly LfoMode[] = ['1-SHOT', 'NORMAL', 'BPM']

/** LFO TARGET @87: 0=CUTOFF,1=SHAPE,2=PITCH. */
export const LFO_TARGET: readonly LfoTarget[] = ['CUTOFF', 'SHAPE', 'PITCH']

/** EG TARGET @80: 0=CUTOFF,1=PITCH2,2=PITCH. */
export const EG_TARGET: readonly FilterEgTarget[] = [
  'CUTOFF',
  'PITCH2',
  'PITCH',
]

/** Sub-type counts per multi engine, for normalizing the TYPE knob position. */
export const MULTI_ENGINE_COUNT: Record<MultiType, number> = {
  NOISE: 4,
  VPM: 16,
  USER: 16,
}

/** SELECT NOISE @39 — multi noise sub-types (shown on the multi LCD). */
export const MULTI_NOISE: readonly string[] = ['HIGH', 'LOW', 'PEAK', 'DECIM']

/** SELECT VPM @40 — multi VPM sub-types. */
export const MULTI_VPM: readonly string[] = [
  'SIN1',
  'SIN2',
  'SIN3',
  'SIN4',
  'SAW1',
  'SAW2',
  'SQU1',
  'SQU2',
  'FAT1',
  'FAT2',
  'AIR1',
  'AIR2',
  'DECAY1',
  'DECAY2',
  'CREEP',
  'THROAT',
]
