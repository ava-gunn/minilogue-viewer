// Audio -> Korg program via Google Gemini, running browser-direct with the user's own
// AI Studio key (no backend). The clip + our param responseSchema + glossary go to Gemini;
// it returns a structured program which we map to raw param values (see gemini/schema.ts).
// The @google/genai SDK is dynamically imported so it stays out of the initial bundle.

import {
  buildResponseSchema,
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

export const DEFAULT_MODEL = 'gemini-3.1-pro-preview'
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

const SYSTEM_INSTRUCTION = `You are an expert sound designer and audio analyst for the Korg minilogue xd.

The minilogue xd is a subtractive synth, so reproduce the CLOSEST achievable approximation of
the sound within its exact signal path — never assume sampling or effects it doesn't have:
- Two analog oscillators VCO1 and VCO2 (each SQR / TRI / SAW, with a SHAPE/PWM control and an
  octave foot 16'/8'/4'/2'), plus one MULTI ENGINE: NOISE (broadband), VPM (2-operator FM-style
  digital — metallic/bell/e-piano), or USER.
- A MIXER blends VCO1, VCO2 and MULTI; set a source's level to 0 when the sound doesn't use it.
- ONE 2-pole (12 dB/oct, gentle) low-pass filter: CUTOFF, RESONANCE (self-oscillates when high),
  DRIVE, KEY TRACK.
- An AMP shaped by the AMP EG (attack / decay / sustain / release).
- ONE assignable EG (eg_target = CUTOFF, PITCH, or PITCH2; eg_int is bipolar, 0.5 = no effect)
  and ONE LFO (lfo_target = PITCH, SHAPE, or CUTOFF; lfo_mode BPM/NORMAL/1-SHOT).
- Effects: MOD (chorus/ensemble/phaser/flanger), DELAY, REVERB.

Analyze the source audio RIGOROUSLY and fill the \`analysis\` object first, then choose program
parameters consistent with it:
1. Pitch — the fundamental, and any glide (→ portamento).
2. Amplitude envelope — attack, decay, sustain level, release, mapped to the AMP EG (percussive
   = fast attack + short decay + low sustain; pad = slow attack + high sustain + long release;
   organ = near-instant on and off).
3. Spectrum & harmonics → waveform + cutoff — bright/buzzy with all harmonics = SAW; hollow with
   odd harmonics = SQR; soft/rounded with few harmonics = TRI; broadband hiss = MULTI NOISE.
   Overall brightness sets CUTOFF; add RESONANCE only for an audible whistle/emphasis.
4. Character — metallic/clangy/inharmonic = RING, CROSS MOD, or MULTI VPM; thick/wide = detune
   vco2_pitch against vco1 (or MOD chorus); gritty/overdriven = FILTER DRIVE.
5. Movement over time — a one-shot brightness sweep = filter EG (eg_target = CUTOFF, eg_int +
   eg_decay); cyclic changes = LFO: pitch wobble→PITCH (vibrato), shape/PWM→SHAPE, brightness
   wah→CUTOFF. State the rough rate and depth, or "none" if static.
6. Effects — enable mod_fx / delay / reverb ONLY where you actually hear them (shimmer, echo, a
   decaying space tail); otherwise leave them off.

Be conservative and faithful: only as much resonance, modulation and effect as the recording
shows; keep VCO pitches centered (0.5) unless you hear detune or an interval; use a single EG
destination (pick the dominant motion); assume POLY voice mode (one sustained held note). The
\`rationale\` should explain your choices in minilogue xd terms. Return ONLY JSON matching the
schema.`

const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
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
}

/** Send the clip to Gemini and return the predicted program. Throws on missing key,
 *  oversized audio, or an unparseable / empty response. */
export async function analyzeAudio(
  file: File,
  { apiKey, model = DEFAULT_MODEL }: AnalyzeOptions,
): Promise<GeminiProgram> {
  if (!apiKey) throw new Error('Add your Gemini API key in settings first.')
  if (file.size > MAX_BYTES) {
    throw new Error('Audio is too large (>18 MB). Use a shorter clip.')
  }

  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey })
  const data = await toBase64(file)

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      // config.responseSchema is SchemaUnion (Schema | unknown), so our GeminiSchema subset
      // is accepted directly — the field shape matches OpenAPI/JSON-schema.
      responseSchema: buildResponseSchema(),
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Analyze this recording, then estimate the minilogue xd program that best ' +
              'reproduces it. Fill the `analysis` from what you actually hear, then set every ' +
              'program parameter consistent with it. Parameter reference ' +
              `(schema ${SCHEMA_VERSION}, prompt ${PROMPT_VERSION}):\n${glossaryText()}`,
          },
          { inlineData: { mimeType: audioMime(file), data } },
        ],
      },
    ],
  })

  const text = response.text
  if (!text) throw new Error('Gemini returned no output.')

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('Gemini returned malformed JSON.')
  }

  const program = (parsed.program ?? parsed) as Record<string, unknown>
  const analysis =
    parsed.analysis && typeof parsed.analysis === 'object'
      ? (parsed.analysis as Record<string, string>)
      : undefined
  return {
    rawById: programToRawById(program),
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    rationale:
      typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
    analysis,
  }
}
