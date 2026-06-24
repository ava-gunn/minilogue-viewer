import { z } from 'zod'
import type { MinilogueXDPatch } from '../types/synth'

const norm = z.number().min(0).max(1)
const bipolar = norm // stored as a 0..1 position
const wave = z.enum(['SQR', 'TRI', 'SAW'])

export const MinilogueXDPatchSchema = z.object({
  name: z.string(),
  voice: z.object({
    mode: z.enum(['POLY', 'UNISON', 'CHORD', 'ARP']),
    modeDepth: norm,
    portamento: norm,
    octave: z.number().int().min(-2).max(2),
  }),
  vco1: z.object({
    wave,
    octave: z.number().int().min(0).max(3),
    pitch: norm,
    shape: norm,
  }),
  vco2: z.object({
    wave,
    octave: z.number().int().min(0).max(3),
    pitch: norm,
    shape: norm,
    crossModDepth: norm,
    sync: z.boolean(),
    ring: z.boolean(),
  }),
  multi: z.object({
    type: z.enum(['NOISE', 'VPM', 'USER']),
    typeValue: norm,
    typeLabel: z.string(),
    shape: norm,
    shiftShape: norm,
  }),
  mixer: z.object({ vco1: norm, vco2: norm, multi: norm }),
  filter: z.object({
    cutoff: norm,
    resonance: norm,
    drive: z.number().int().min(0).max(2),
    keyTracking: z.number().int().min(0).max(2),
  }),
  ampEnv: z.object({
    attack: norm,
    decay: norm,
    sustain: norm,
    release: norm,
  }),
  filterEnv: z.object({
    attack: norm,
    decay: norm,
    int: bipolar,
    target: z.enum(['PITCH', 'PITCH2', 'CUTOFF']),
  }),
  lfo: z.object({
    wave,
    mode: z.enum(['BPM', 'NORMAL', '1-SHOT']),
    rate: norm,
    int: bipolar,
    target: z.enum(['PITCH', 'SHAPE', 'CUTOFF']),
  }),
  modFx: z.object({ on: z.boolean() }),
  delay: z.object({ on: z.boolean(), time: norm, depth: norm }),
  reverb: z.object({ on: z.boolean(), time: norm, depth: norm }),
}) satisfies z.ZodType<MinilogueXDPatch>

/** Validate a parsed patch at the boundary, returning the typed patch. */
export function validatePatch(patch: unknown): MinilogueXDPatch {
  return MinilogueXDPatchSchema.parse(patch)
}
