// Pairs are later pulled into the training repo by training/data/pull_contributions.py.

import { PROMPT_VERSION, SCHEMA_VERSION } from '../gemini/schema'

export type Engine = 'builtin' | 'gemini'
/** 'as-is' = generated patch is a good match; 'adjusted' = user's hardware-tweaked version as a better label. */
export type Rating = 'as-is' | 'adjusted'

export interface ContributionInput {
  file: File
  rawById: Record<string, number>
  name: string | undefined
  pitchMidi: number
  model: string
  engine: Engine
  rating: Rating
  /** Gemini's structured audio analysis + rationale (absent for the built-in engine). */
  analysis?: Record<string, string> | undefined
  rationale?: string | undefined
  turnstileToken?: string | undefined
}

export async function submitContribution(
  input: ContributionInput,
): Promise<string> {
  const form = new FormData()
  form.append('audio', input.file, input.file.name)
  form.append(
    'meta',
    JSON.stringify({
      rawById: input.rawById,
      name: input.name,
      pitchMidi: input.pitchMidi,
      model: input.model,
      engine: input.engine,
      rating: input.rating,
      analysis: input.analysis,
      rationale: input.rationale,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    }),
  )

  if (input.turnstileToken) form.append('turnstileToken', input.turnstileToken)

  const res = await fetch('/api/contribute', { method: 'POST', body: form })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Submit failed (${res.status}). ${detail}`.trim())
  }
  const data = (await res.json()) as { id: string }
  return data.id
}
