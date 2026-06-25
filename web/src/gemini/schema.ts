// Gemini structured-output schema + prompt context for audio -> Korg program, derived
// from the shared PARAM_SPEC so it can't drift from the model/byte layout. Gemini emits
// one value per param id (continuous 0..1, discrete as a label/index, boolean); we map
// that to raw param space exactly as training/eval/infer.py's decode_raw does, then reuse
// rawByIdToPatch() for display. Kept free of the @google/genai import so it's unit-testable.

import { PARAM_SPEC } from '../parser/param-spec'

// Bump when the prompt or the schema mapping changes, so submissions carry provenance and
// stale-prompt data is filterable downstream.
export const PROMPT_VERSION = 'gemini-resynth-v3'
export const SCHEMA_VERSION = 'xd-params-52-v1'

/** Minimal JSON-schema subset accepted by @google/genai's responseSchema. */
export interface GeminiSchema {
  type: 'OBJECT' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY'
  description?: string
  enum?: string[]
  properties?: Record<string, GeminiSchema>
  required?: string[]
  propertyOrdering?: string[]
}

// Musical meaning of each param — the raw byte schema alone isn't enough for Gemini to
// produce a sensible patch. Bipolar continuous params note that 0.5 is centered.
export const PARAM_GLOSSARY: Record<string, string> = {
  octave: 'master octave; 0..4 maps to -2..+2 octaves (2 = center)',
  portamento: 'glide time between notes; 0 = off',
  voice_mode_depth:
    'amount for the active voice mode (for UNISON, the detune spread of the stacked voices)',
  voice_mode:
    'voice assignment; default UNISON (stacks all voices on one note for a fuller monophonic sound). Use POLY ONLY when the source is polyphonic (a chord / multiple simultaneous notes); ARP and CHORD are special note-count modes',
  vco1_wave:
    'VCO1 waveform: SQR = hollow/square, TRI = soft/mellow, SAW = bright/buzzy',
  vco1_octave: "VCO1 octave: 0=16' (lowest), 1=8', 2=4', 3=2' (highest)",
  vco1_pitch:
    'VCO1 fine pitch; 0.5 = centered (full range about +/-1200 cents)',
  vco1_shape: 'VCO1 wave shape / PWM amount',
  vco2_wave: 'VCO2 waveform: SQR, TRI, SAW',
  vco2_octave: "VCO2 octave: 0=16', 1=8', 2=4', 3=2'",
  vco2_pitch:
    'VCO2 fine pitch; 0.5 = centered (detune VCO2 vs VCO1 for thickness/beating)',
  vco2_shape: 'VCO2 wave shape / PWM amount',
  sync: 'VCO2 hard-sync to VCO1; on = harsh, aggressive, vocal-ish timbre',
  ring: 'ring modulation of VCO1 x VCO2; on = metallic, clangy, inharmonic',
  cross_mod_depth:
    'VCO2 -> VCO1 cross modulation depth (FM-like; adds sidebands/grit)',
  multi_type: 'MULTI engine: NOISE, VPM (FM-style digital), or USER oscillator',
  multi_select_noise: 'noise variant (only when multi_type = NOISE)',
  multi_select_vpm: 'VPM oscillator variant 0..15 (only when multi_type = VPM)',
  multi_select_user: 'USER oscillator slot 0..15 (only when multi_type = USER)',
  multi_shape_noise: 'shape of the NOISE engine',
  multi_shape_vpm: 'shape of the VPM engine (modulation index / brightness)',
  multi_shape_user: 'shape of the USER engine',
  multi_shift_shape_noise: 'secondary shift-shape of the NOISE engine',
  multi_shift_shape_vpm: 'secondary shift-shape of the VPM engine',
  multi_shift_shape_user: 'secondary shift-shape of the USER engine',
  mixer_vco1:
    'VCO1 level into the filter; 0 = silent (set 0 if VCO1 is unused)',
  mixer_vco2: 'VCO2 level into the filter; 0 = silent',
  mixer_multi: 'MULTI engine level into the filter; 0 = silent',
  cutoff: 'low-pass filter cutoff; 0 = dark/closed, 1 = bright/open',
  resonance:
    'filter resonance/emphasis at cutoff; high = whistly, near self-oscillation',
  filter_drive: 'filter drive/saturation: 0%, 50%, 100%',
  filter_key_track: 'filter cutoff tracking of note pitch: 0%, 50%, 100%',
  amp_attack: 'amplitude envelope attack time; high = slow fade-in/pad',
  amp_decay: 'amplitude envelope decay time',
  amp_sustain:
    'amplitude envelope sustain level; high = note holds at full level',
  amp_release:
    'amplitude envelope release time; high = long tail after note-off',
  eg_attack: 'filter envelope attack time',
  eg_decay: 'filter envelope decay time',
  eg_int:
    'filter envelope intensity; 0.5 = none, >0.5 opens cutoff, <0.5 closes it',
  eg_target: 'filter EG destination: PITCH, PITCH2, or CUTOFF',
  lfo_wave: 'LFO waveform: SQR, TRI, SAW',
  lfo_mode: 'LFO mode: BPM (tempo-synced), NORMAL (free), or 1-SHOT',
  lfo_rate: 'LFO speed',
  lfo_int: 'LFO intensity/amount; 0.5 = none',
  lfo_target: 'LFO destination: PITCH (vibrato), SHAPE, or CUTOFF (wah/wobble)',
  mod_fx_on: 'modulation effect on/off (chorus/ensemble/phaser/flanger family)',
  delay_on: 'delay effect on/off',
  delay_time: 'delay time',
  delay_depth: 'delay feedback / wet depth',
  reverb_on: 'reverb on/off',
  reverb_time: 'reverb size / decay time',
  reverb_depth: 'reverb wet depth',
}

// What Gemini must determine from the source audio before choosing parameters. Each field maps
// onto a section of the minilogue xd, so the analysis and the resulting program stay consistent
// (and we get the rigorous, Korg-relevant breakdown back for training/eval).
export const ANALYSIS_FIELDS: Record<string, string> = {
  sound_type:
    'what kind of sound this is — name the instrument/category, e.g. "synthetic brass/horn (braaam)", "plucked bass", "warm pad", "saw lead", "FM bell", "electric piano", "organ", "noise sweep/riser", "percussion"',
  pitch:
    'fundamental pitch / note(s); whether it is a single note (monophonic → UNISON) or a chord / multiple simultaneous notes (polyphonic → POLY); and any glide between notes (→ portamento)',
  dynamics:
    'amplitude envelope across the note: attack, decay, sustain level, release (→ AMP EG); e.g. "instant attack, no sustain, short release — plucky"',
  brightness:
    'overall spectral brightness and whether it stays steady, opens, or closes over the note (→ CUTOFF, plus a filter EG sweep if it moves)',
  harmonics:
    'harmonic content and the waveform(s) it implies: buzzy/all-harmonics=SAW, hollow/odd=SQR, soft/few=TRI, broadband hiss=MULTI NOISE, metallic/inharmonic=RING·CROSS-MOD·VPM',
  movement:
    'periodic modulation and its rough rate/depth: vibrato (LFO→PITCH), tremolo or PWM (LFO→SHAPE), wah (LFO→CUTOFF); "none" if static',
  effects:
    'audible effects only: chorus/ensemble (MOD), echo (DELAY), room/space tail (REVERB); "dry" if none',
}

function paramSchema(id: string): GeminiSchema {
  const p = PARAM_SPEC.find((s) => s.id === id)
  if (!p) throw new Error(`unknown param ${id}`)
  const description = PARAM_GLOSSARY[id] ?? id
  if (p.type === 'continuous') {
    return { type: 'NUMBER', description: `${description} (0..1)` }
  }
  if (p.type === 'boolean') {
    return { type: 'BOOLEAN', description }
  }
  if (p.values) {
    return { type: 'STRING', enum: [...p.values], description }
  }
  return {
    type: 'INTEGER',
    description: `${description} (0..${p.cardinality - 1})`,
  }
}

/** Pass-1 responseSchema: the structured audio analysis ONLY. Kept free of the 52-param program
 *  and the param glossary so the model's whole job in that call is to LISTEN and describe the
 *  source — sharing the call with patch generation pulled it into "design a patch" mode and the
 *  analysis suffered. */
export function buildAnalysisSchema(): GeminiSchema {
  const properties: Record<string, GeminiSchema> = {}
  const ordering: string[] = []
  for (const [id, description] of Object.entries(ANALYSIS_FIELDS)) {
    properties[id] = { type: 'STRING', description }
    ordering.push(id)
  }
  return {
    type: 'OBJECT',
    properties,
    propertyOrdering: ordering,
    required: ordering,
  }
}

/** Pass-2 responseSchema: the `program` (one property per param id in spec order) plus a short
 *  name and rationale, designed from the pass-1 analysis. */
export function buildProgramSchema(): GeminiSchema {
  const properties: Record<string, GeminiSchema> = {}
  const ordering: string[] = []
  for (const p of PARAM_SPEC) {
    properties[p.id] = paramSchema(p.id)
    ordering.push(p.id)
  }
  return {
    type: 'OBJECT',
    properties: {
      program: {
        type: 'OBJECT',
        properties,
        propertyOrdering: ordering,
        required: ordering,
      },
      name: { type: 'STRING', description: 'short patch name, <= 12 chars' },
      rationale: {
        type: 'STRING',
        description:
          'one or two sentences mapping the analysis to the chosen minilogue xd parameters',
      },
    },
    propertyOrdering: ['program', 'name', 'rationale'],
    required: ['program'],
  }
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/** Gemini's `program` object -> raw param values by id. Continuous round(value*rawMax);
 *  discrete = label index (or the integer); boolean -> 0/1. Mirrors decode_raw in
 *  training/eval/infer.py so the browser and the trainer agree on raw values. */
export function programToRawById(
  program: Record<string, unknown>,
): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const p of PARAM_SPEC) {
    const value = program[p.id]
    if (p.type === 'continuous') {
      const v = clamp(Number(value) || 0, 0, 1)
      raw[p.id] = Math.round(v * p.rawMax)
    } else if (p.type === 'boolean') {
      raw[p.id] = value === true || value === 1 || value === '1' ? 1 : 0
    } else {
      let idx = -1
      if (p.values && typeof value === 'string') idx = p.values.indexOf(value)
      if (idx < 0) idx = Math.round(Number(value) || 0)
      raw[p.id] = clamp(idx, 0, p.cardinality - 1)
    }
  }
  return raw
}
