// Send an approved (audio + predicted program) pair to /api/contribute, which stores the
// audio in Vercel Blob and the metadata in KV. The pair is later pulled into the training
// repo (training/data/pull_contributions.py) to grow the eval set + a pseudo-labeled split.

import { PROMPT_VERSION, SCHEMA_VERSION } from '../gemini/schema'

export type Engine = 'builtin' | 'gemini'
export type Rating = 'up' | 'down'

export interface ContributionInput {
  file: File
  rawById: Record<string, number>
  name: string | undefined
  pitchMidi: number
  model: string
  engine: Engine
  rating: Rating
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
