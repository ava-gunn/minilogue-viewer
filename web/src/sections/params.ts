import { clamp01, lfoRateDivision, pitchToCents } from '../parser/transforms'
import type { MinilogueXDPatch } from '../types/synth'

/**
 * Maps each panel control (by section + key, matching the HTML data-* attrs)
 * to the value it should display and an optional human-readable readout.
 *
 * `value` is what the control consumes: a normalized 0..1 position for knobs,
 * or a discrete index for switches / wave-selectors / LED groups. Discrete
 * index order MUST match the control's `positions`/`labels` order in index.html.
 */
export interface ParamDescriptor {
  section: string
  key: string
  value: (p: MinilogueXDPatch) => number
  display?: (p: MinilogueXDPatch) => string
}

// Discrete orderings — must mirror the index.html positions/labels.
const WAVE = ['SQR', 'TRI', 'SAW']
const VOICE = ['POLY', 'UNISON', 'CHORD', 'ARP']
const MULTI = ['NOISE', 'VPM', 'USER']
const EG_TARGET = ['PITCH', 'PITCH2', 'CUTOFF']
const LFO_MODE = ['BPM', 'NORMAL', '1-SHOT']
const LFO_TARGET = ['PITCH', 'SHAPE', 'CUTOFF']
const FEET = ["16'", "8'", "4'", "2'"]
const PERCENT3 = ['0%', '50%', '100%']

const raw10 = (pos: number): number => Math.round(pos * 1023)
// Actual stored program values (10-bit / 7-bit), not normalized percentages.
const rawVal = (v: number): string => String(raw10(v))
const raw7 = (v: number): string => String(Math.round(v * 127))
const signed = (n: number, unit: string): string =>
  `${n > 0 ? '+' : ''}${n}${unit}`

const knob = (
  section: string,
  key: string,
  value: (p: MinilogueXDPatch) => number,
  display?: (p: MinilogueXDPatch) => string,
): ParamDescriptor => ({
  section,
  key,
  value,
  display: display ?? ((p) => rawVal(value(p))),
})

const cents = (get: (p: MinilogueXDPatch) => number) => (p: MinilogueXDPatch) =>
  signed(pitchToCents(raw10(get(p))), '¢')
// VCO pitch is bipolar ±1200¢ (0 at noon); position the dial by cents so it
// tracks the readout — raw is fine near center, which would skew the dial.
const pitchPos =
  (get: (p: MinilogueXDPatch) => number) => (p: MinilogueXDPatch) =>
    clamp01((pitchToCents(raw10(get(p))) + 1200) / 2400)
// INT readout: the signed offset from the 512 center (e.g. raw 521 → +9).
const bipolar =
  (get: (p: MinilogueXDPatch) => number) => (p: MinilogueXDPatch) =>
    signed(raw10(get(p)) - 512, '')
// LFO INT is a unipolar knob: its positive range uses raw 512..1023, so the
// dial sweeps from min (raw 512) to full (raw 1023) — a small value like +9
// sits near the bottom (~8 o'clock), not at noon.
const intPos =
  (get: (p: MinilogueXDPatch) => number) => (p: MinilogueXDPatch) =>
    clamp01((raw10(get(p)) - 512) / 511)

export const PARAMS: ParamDescriptor[] = [
  // VOICE
  knob(
    'voice',
    'portamento',
    (p) => p.voice.portamento,
    (p) => raw7(p.voice.portamento),
  ),
  knob('voice', 'modeDepth', (p) => p.voice.modeDepth),
  {
    section: 'voice',
    key: 'mode',
    value: (p) => VOICE.indexOf(p.voice.mode),
    display: (p) => p.voice.mode,
  },

  // VCO1
  {
    section: 'vco1',
    key: 'wave',
    value: (p) => WAVE.indexOf(p.vco1.wave),
    display: (p) => p.vco1.wave,
  },
  {
    section: 'vco1',
    key: 'octave',
    value: (p) => p.vco1.octave,
    display: (p) => FEET[p.vco1.octave] ?? '',
  },
  knob(
    'vco1',
    'pitch',
    pitchPos((p) => p.vco1.pitch),
    cents((p) => p.vco1.pitch),
  ),
  knob('vco1', 'shape', (p) => p.vco1.shape),

  // VCO2
  {
    section: 'vco2',
    key: 'wave',
    value: (p) => WAVE.indexOf(p.vco2.wave),
    display: (p) => p.vco2.wave,
  },
  {
    section: 'vco2',
    key: 'octave',
    value: (p) => p.vco2.octave,
    display: (p) => FEET[p.vco2.octave] ?? '',
  },
  knob(
    'vco2',
    'pitch',
    pitchPos((p) => p.vco2.pitch),
    cents((p) => p.vco2.pitch),
  ),
  knob('vco2', 'shape', (p) => p.vco2.shape),
  knob('vco2', 'crossModDepth', (p) => p.vco2.crossModDepth),
  { section: 'vco2', key: 'sync', value: (p) => (p.vco2.sync ? 1 : 0) },
  { section: 'vco2', key: 'ring', value: (p) => (p.vco2.ring ? 1 : 0) },

  // MULTI ENGINE
  {
    section: 'multi',
    key: 'type',
    value: (p) => MULTI.indexOf(p.multi.type),
    display: (p) => p.multi.type,
  },
  knob(
    'multi',
    'typeValue',
    (p) => p.multi.typeValue,
    (p) => p.multi.typeLabel,
  ),
  knob('multi', 'shape', (p) => p.multi.shape),

  // MIXER
  knob('mixer', 'vco1', (p) => p.mixer.vco1),
  knob('mixer', 'vco2', (p) => p.mixer.vco2),
  knob('mixer', 'multi', (p) => p.mixer.multi),

  // FILTER
  knob('filter', 'cutoff', (p) => p.filter.cutoff),
  knob('filter', 'resonance', (p) => p.filter.resonance),
  {
    section: 'filter',
    key: 'drive',
    value: (p) => p.filter.drive,
    display: (p) => PERCENT3[p.filter.drive] ?? '',
  },
  {
    section: 'filter',
    key: 'keyTracking',
    value: (p) => p.filter.keyTracking,
    display: (p) => PERCENT3[p.filter.keyTracking] ?? '',
  },

  // AMP EG
  knob('ampEnv', 'attack', (p) => p.ampEnv.attack),
  knob('ampEnv', 'decay', (p) => p.ampEnv.decay),
  knob('ampEnv', 'sustain', (p) => p.ampEnv.sustain),
  knob('ampEnv', 'release', (p) => p.ampEnv.release),

  // FILTER EG
  knob('filterEnv', 'attack', (p) => p.filterEnv.attack),
  knob('filterEnv', 'decay', (p) => p.filterEnv.decay),
  knob(
    'filterEnv',
    'int',
    (p) => p.filterEnv.int,
    bipolar((p) => p.filterEnv.int),
  ),
  {
    section: 'filterEnv',
    key: 'target',
    value: (p) => EG_TARGET.indexOf(p.filterEnv.target),
    display: (p) => p.filterEnv.target,
  },

  // LFO
  {
    section: 'lfo',
    key: 'wave',
    value: (p) => WAVE.indexOf(p.lfo.wave),
    display: (p) => p.lfo.wave,
  },
  {
    section: 'lfo',
    key: 'mode',
    value: (p) => LFO_MODE.indexOf(p.lfo.mode),
    display: (p) => p.lfo.mode,
  },
  knob(
    'lfo',
    'rate',
    (p) => p.lfo.rate,
    (p) =>
      p.lfo.mode === 'BPM'
        ? lfoRateDivision(raw10(p.lfo.rate))
        : rawVal(p.lfo.rate),
  ),
  knob(
    'lfo',
    'int',
    intPos((p) => p.lfo.int),
    bipolar((p) => p.lfo.int),
  ),
  {
    section: 'lfo',
    key: 'target',
    value: (p) => LFO_TARGET.indexOf(p.lfo.target),
    display: (p) => p.lfo.target,
  },

  // EFFECTS (panel TIME/DEPTH show the reverb slot)
  knob('reverb', 'time', (p) => p.reverb.time),
  knob('reverb', 'depth', (p) => p.reverb.depth),
  // Effect on/off (1 = on) — drives the FX status lights + the ON/OFF toggle.
  {
    section: 'modFx',
    key: 'on',
    value: (p) => (p.modFx.on ? 1 : 0),
    display: (p) => (p.modFx.on ? 'ON' : 'OFF'),
  },
  {
    section: 'delay',
    key: 'on',
    value: (p) => (p.delay.on ? 1 : 0),
    display: (p) => (p.delay.on ? 'ON' : 'OFF'),
  },
  {
    section: 'reverb',
    key: 'on',
    value: (p) => (p.reverb.on ? 1 : 0),
    display: (p) => (p.reverb.on ? 'ON' : 'OFF'),
  },
]
