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

const SYSTEM_INSTRUCTION =
  'You are an expert sound designer for the Korg minilogue xd, a 2-VCO + multi-engine ' +
  'analog/digital subtractive synthesizer. Given a recording of a single sustained ' +
  'note or sound, estimate the program (patch) parameters that would best reproduce it ' +
  'on the minilogue xd. Reason about oscillators, mix, filter, envelopes, LFO and ' +
  'effects from the timbre, brightness, attack/release and movement you hear. Return ' +
  'ONLY JSON matching the provided schema; assume POLY voice mode (a single held note).'

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
              'Estimate a minilogue xd program for this sound. Parameter reference ' +
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
  return {
    rawById: programToRawById(program),
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    rationale:
      typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
  }
}
