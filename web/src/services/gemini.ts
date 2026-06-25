// Audio -> Korg program via Google Gemini, running browser-direct with the user's own AI Studio
// key (no backend). Two passes (see analyzeAudio): pass 1 LISTENS — audio + waveform → a
// structured description of the source, with no synth params in scope so the model isn't pulled
// into "design a patch" mode; pass 2 DESIGNS — that description + the param glossary → a program
// we map to raw values (gemini/schema.ts). The @google/genai SDK is dynamically imported so it
// stays out of the initial bundle.

import {
  buildAnalysisSchema,
  buildProgramSchema,
  continuousToRaw,
  PARAM_GLOSSARY,
  PROMPT_VERSION,
  programToRawById,
  SCHEMA_VERSION,
} from '../gemini/schema'

export interface GeminiProgram {
  /** Raw param values by spec id — feeds rawByIdToPatch() and the contribution upload. */
  rawById: Record<string, number>
  name?: string | undefined
  rationale?: string | undefined
  /** Structured analysis of the source audio (pitch, dynamics, brightness, …) — shown to the
   *  user and uploaded with the contribution. */
  analysis?: Record<string, string> | undefined
}

export const DEFAULT_MODEL = 'gemini-2.5-flash'
// Models offered in the picker, newest first. (gemini-3-pro-preview was retired
// 2026-03-09 → use gemini-3.1-pro-preview; gemini-3-flash-preview became gemini-3.5-flash.)
export const MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const

// Inline base64 keeps it simple; larger clips would need the Files API (follow-up).
const MAX_BYTES = 18 * 1024 * 1024

// Pass 1 — LISTEN. The model's only job is to characterise the SOURCE audio; deliberately no
// synth vocabulary so it describes what it hears instead of designing a patch.
const ANALYST_INSTRUCTION = `You are an expert audio analyst. You are given a short recording of a single instrument or synth sound (and usually an image of its amplitude waveform). LISTEN to it and describe ONLY what you actually hear in the SOURCE — do not design or mention any synthesizer settings; just characterise the sound faithfully and specifically.

Fill every analysis field:
- sound_type: what the sound is (e.g. synthetic brass/horn "braaam", plucked bass, warm pad, saw lead, FM bell, electric piano, organ, drone, riser/sweep, percussion).
- pitch: the fundamental note; whether it is a single note (monophonic) or a chord / multiple simultaneous notes (polyphonic); and any pitch glide.
- dynamics: the amplitude envelope — attack (a sharp/vertical onset = instant; a gradual rise = slow), decay, sustain level (a flat plateau = sustained; a fall toward zero = not), and the release tail. Use the waveform image and the stated clip duration; give times relative to the clip (e.g. "instant attack, decays over ~0.3 s, no sustain").
- brightness: overall spectral brightness, and whether it stays steady, opens, or closes over the note.
- harmonics: harmonic content / timbre (buzzy and full of harmonics, hollow, soft and rounded, noisy, metallic/inharmonic, FM-like…).
- movement: periodic modulation and its rough rate/depth (vibrato, tremolo, PWM, wah), or "none".
- effects: audible effects only (chorus/ensemble, delay/echo, reverb/space), or "dry".
- envelope: numeric AMP envelope (attack, decay, sustain, release, each 0..1) measured from the waveform — these drive the synth's amp EG directly, so be accurate. sustain is the LEVEL held while the note continues: 0 for a sound that decays to silence on its own (plucked, percussive, one-shot), high only for a sound that holds steady. release is the tail after note-off: short unless it visibly rings out. Keep these consistent with your prose "dynamics".

Be specific and honest: if something is steady or absent, say so. Return ONLY JSON matching the schema.`

// Pass 2 — DESIGN. Given the pass-1 description (no audio here), build the minilogue xd program.
const SYNTH_INSTRUCTION = `You are an expert sound designer for the Korg minilogue xd. Given an analysis of a source sound, design the minilogue xd program that best reproduces it. The synth is subtractive, so approximate the sound within its exact signal path:
- VCO1 + VCO2 (each SQR/TRI/SAW, with a SHAPE/PWM control and an octave foot 16'/8'/4'/2') + one MULTI ENGINE (NOISE, VPM = 2-op FM-style digital, USER), blended in the MIXER (set unused sources to 0).
- ONE 2-pole low-pass filter: CUTOFF, RESONANCE (self-oscillates when high), DRIVE, KEY TRACK.
- AMP shaped by the AMP EG (attack/decay/sustain/release).
- ONE assignable EG (eg_target = CUTOFF/PITCH/PITCH2; eg_int bipolar, 0.5 = none) and ONE LFO (lfo_target = PITCH/SHAPE/CUTOFF).
- Effects: MOD (chorus/ensemble/phaser/flanger), DELAY, REVERB.

Map the analysis faithfully:
- dynamics → AMP EG. An instant / immediately-loud attack = amp_attack ≈ 0 (NEVER a slow attack for a sound that starts loud); pad = slow attack + high sustain + long release; pluck = fast attack + short decay + low sustain. Scale times to the clip duration.
- harmonics/brightness → waveform + CUTOFF (buzzy/all harmonics = SAW, hollow/odd = SQR, soft/few = TRI, hiss = MULTI NOISE; brightness sets CUTOFF; RESONANCE only for an audible whistle).
- character (metallic/inharmonic) → RING, CROSS MOD, or MULTI VPM; thick/wide → detune vco2_pitch or MOD chorus; gritty → FILTER DRIVE.
- movement → filter EG for a one-shot sweep, LFO for cyclic motion (PITCH/SHAPE/CUTOFF).
- effects → enable mod_fx / delay / reverb only where the analysis says they are present.
- voice_mode → UNISON for a monophonic source (thicken via voice_mode_depth); POLY only if the analysis says polyphonic.

Keep VCO pitches centered (0.5) unless detune or an interval is noted; use a single EG destination; only as much resonance/modulation/effect as the analysis shows. Give a short \`name\` and a \`rationale\` explaining the mapping in minilogue xd terms. Return ONLY JSON matching the schema.`

// Gemini's documented audio MIME types (mp3 is audio/mp3, NOT audio/mpeg; m4a/aac are audio/aac).
const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/aac',
  aac: 'audio/aac',
}

function audioMime(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return AUDIO_MIME[ext] ?? (file.type || 'audio/wav')
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const glossaryText = (): string =>
  Object.entries(PARAM_GLOSSARY)
    .map(([id, desc]) => `- ${id}: ${desc}`)
    .join('\n')

export interface AnalyzeOptions {
  apiKey: string
  model?: string
  /** Base64 PNG (no data: prefix) of the clip's waveform — sent alongside the audio so the model
   *  can read the amplitude envelope visually. */
  waveformPng?: string | undefined
  /** Clip length in seconds — envelope times must fit within it (a 0.4 s clip can't have a
   *  multi-second attack/release). */
  durationSec?: number | undefined
  /** Optional progress callback (the two passes take a moment each). */
  onProgress?: ((message: string) => void) | undefined
}

// Minimal genai client surface we use, so we can type the helpers without importing the SDK
// statically (it's dynamically imported to keep it out of the initial bundle).
type GenAI = {
  models: {
    generateContent: (req: {
      model: string
      config: Record<string, unknown>
      contents: unknown
    }) => Promise<{ text?: string }>
  }
}
type ContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

function parseJson(text: string | undefined, what: string): Record<string, unknown> {
  if (!text) throw new Error(`Gemini returned no ${what}.`)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Gemini returned malformed ${what} JSON.`)
  }
}

const durationNote = (durationSec?: number): string =>
  durationSec && durationSec > 0
    ? ` The clip is ${durationSec.toFixed(2)} seconds long; describe and scale envelope times relative to that.`
    : ''

/** Pass 1 — listen to the clip and return a structured description of the SOURCE sound, plus a
 *  numeric AMP envelope measured from the waveform. */
async function describeAudio(
  ai: GenAI,
  model: string,
  file: File,
  waveformPng: string | undefined,
  durationSec: number | undefined,
): Promise<{
  analysis: Record<string, string>
  envelope: Record<string, number> | undefined
}> {
  const data = await toBase64(file)
  const parts: ContentPart[] = [
    { inlineData: { mimeType: audioMime(file), data } },
  ]
  if (waveformPng) parts.push({ inlineData: { mimeType: 'image/png', data: waveformPng } })
  parts.push({
    text:
      'Listen to this recording' +
      (waveformPng
        ? ' (the image is its amplitude waveform — x = time from onset, full width = the clip, y = amplitude — read the envelope from it)'
        : '') +
      ` and describe the SOURCE sound, filling every analysis field with what you actually hear.${durationNote(durationSec)}`,
  })

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: ANALYST_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: buildAnalysisSchema(),
    },
    contents: [{ role: 'user', parts }],
  })
  const parsed = parseJson(response.text, 'analysis')
  const analysis = Object.fromEntries(
    Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>
  const env = parsed.envelope
  const envelope =
    env && typeof env === 'object' && !Array.isArray(env)
      ? (env as Record<string, number>)
      : undefined
  return { analysis, envelope }
}

/** Pass 2 — design the minilogue xd program from the pass-1 analysis (no audio needed). */
async function designProgram(
  ai: GenAI,
  model: string,
  analysis: Record<string, string>,
  durationSec: number | undefined,
): Promise<{
  program: Record<string, unknown>
  name?: string | undefined
  rationale?: string | undefined
}> {
  const analysisText = Object.entries(analysis)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')
  const duration =
    durationSec && durationSec > 0
      ? `\nClip duration: ${durationSec.toFixed(2)} s (scale AMP envelope times to it).`
      : ''
  const text =
    `Analysis of the source sound:\n${analysisText}${duration}\n\n` +
    'Design the minilogue xd program that reproduces it. Parameter reference ' +
    `(schema ${SCHEMA_VERSION}, prompt ${PROMPT_VERSION}):\n${glossaryText()}`

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: SYNTH_INSTRUCTION,
      responseMimeType: 'application/json',
      // config.responseSchema is SchemaUnion (Schema | unknown), so our GeminiSchema subset
      // is accepted directly — the field shape matches OpenAPI/JSON-schema.
      responseSchema: buildProgramSchema(),
    },
    contents: [{ role: 'user', parts: [{ text }] }],
  })
  const parsed = parseJson(response.text, 'program')
  const program = (parsed.program ?? parsed) as Record<string, unknown>
  return {
    program,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    rationale:
      typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
  }
}

/** Two passes — listen, then design — and return the predicted program. Throws on missing key,
 *  oversized audio, or an unparseable / empty response. */
export async function analyzeAudio(
  file: File,
  {
    apiKey,
    model = DEFAULT_MODEL,
    waveformPng,
    durationSec,
    onProgress,
  }: AnalyzeOptions,
): Promise<GeminiProgram> {
  if (!apiKey) throw new Error('Add your Gemini API key in settings first.')
  if (file.size > MAX_BYTES) {
    throw new Error('Audio is too large (>18 MB). Use a shorter clip.')
  }

  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey }) as unknown as GenAI

  onProgress?.('Listening to the audio…')
  const { analysis, envelope } = await describeAudio(
    ai,
    model,
    file,
    waveformPng,
    durationSec,
  )

  onProgress?.('Designing the patch…')
  const { program, name, rationale } = await designProgram(
    ai,
    model,
    analysis,
    durationSec,
  )

  const rawById = programToRawById(program)
  // The AMP envelope is measured in the listen pass (where the waveform is visible) and written
  // straight onto the amp EG — pass 2's prose interpretation tended to over-sustain, producing
  // patches that droned on when the description said otherwise.
  const AMP_EG: Record<string, string> = {
    attack: 'amp_attack',
    decay: 'amp_decay',
    sustain: 'amp_sustain',
    release: 'amp_release',
  }
  if (envelope) {
    for (const [k, id] of Object.entries(AMP_EG)) {
      if (typeof envelope[k] === 'number') rawById[id] = continuousToRaw(id, envelope[k])
    }
    const n = (v: number): string => (typeof v === 'number' ? v.toFixed(2) : '?')
    analysis.envelope = `attack ${n(envelope.attack)}, decay ${n(envelope.decay)}, sustain ${n(envelope.sustain)}, release ${n(envelope.release)}`
  }

  return { rawById, name, rationale, analysis }
}
