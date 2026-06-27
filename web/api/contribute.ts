// POST /api/contribute — receive an approved (audio + predicted program) pair from the
// Gemini re-synthesis flow. Audio goes to Vercel Blob; a metadata record (rawById, pitch,
// model, prompt/schema version) is stored alongside it as meta.json. Pulled into the
// training repo later by training/data/pull_contributions.py.
//
// Audio clips are tiny (a 1s mono WAV is ~90 KB), well under Vercel's request body limit.
// No Gemini key reaches the server — inference is browser-direct with the user's own key.

import { randomUUID } from 'node:crypto'
import { put } from '@vercel/blob'

// Node.js runtime (the default): @vercel/blob depends on Node stream/undici modules that
// the Edge runtime can't provide. The Web Request/Response handler signature works here too.

// Reject obviously-wrong payloads early. The full param count is enforced loosely here and
// strictly when the record is materialized by the Python puller.
const MIN_PARAMS = 40
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const MAX_NAME_LEN = 200
// Pin the stored object's extension + content-type to an allowlist rather than trusting the
// client filename/MIME (the blob is served at a public URL).
const AUDIO_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}
const RATE_LIMIT = 20
const RATE_WINDOW_S = 3600

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientIp(req: Request): string {
  // x-real-ip is set by Vercel to the true client IP (not client-spoofable). Fall back to the
  // RIGHTMOST x-forwarded-for hop (the one Vercel appended), never the client-controlled left.
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',')
  return xff[xff.length - 1]?.trim() || 'unknown'
}

/** Per-IP fixed-window limit via the Vercel KV (Upstash) REST API. Fails OPEN when KV is
 *  unconfigured or errors — availability over strictness, since Turnstile is the real gate. */
async function rateLimited(ip: string): Promise<boolean> {
  // Vercel sunset first-party KV; the Marketplace Upstash integration now injects
  // UPSTASH_REDIS_REST_*. Accept either (KV_* kept for any pre-migration stores). Both speak the
  // same Upstash REST API (/pipeline + Bearer), so only the env-var names differ.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const auth =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !auth) {
    if (process.env.VERCEL_ENV === 'production') {
      console.warn('rate limiting disabled: KV not configured')
    }
    return false // fail open: availability over strictness (Turnstile is the real gate)
  }
  try {
    const key = `rl:contribute:${ip}`
    // One pipelined round-trip: create the key with its TTL atomically (SET .. EX .. NX),
    // then INCR — so a crash can't leave a TTL-less (permanently-blocking) key.
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        ['SET', key, '0', 'EX', String(RATE_WINDOW_S), 'NX'],
        ['INCR', key],
      ]),
    })
    const out = (await res.json()) as Array<{ result?: number }>
    return Number(out[1]?.result ?? 0) > RATE_LIMIT
  } catch {
    return false
  }
}

/** Verify a Cloudflare Turnstile token. Skipped if TURNSTILE_SECRET_KEY is unset (set it in
 *  production); otherwise fails CLOSED on a missing/invalid token. */
async function turnstileOk(token: string | null, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  // Fail CLOSED in production if the secret is missing — a dropped env var must not silently
  // disable the captcha. The skip is allowed only outside production (local/preview dev).
  if (!secret) return process.env.VERCEL_ENV !== 'production'
  if (!token) return false
  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      },
    )
    const data = (await res.json()) as { success?: boolean; hostname?: string }
    if (data.success !== true) return false
    // If a hostname is pinned, reject tokens solved on another origin (token-sharing abuse).
    const expected = process.env.TURNSTILE_HOSTNAME
    return !expected || data.hostname === expected
  } catch {
    return false
  }
}

export async function POST(req: Request): Promise<Response> {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) return json({ error: 'storage not configured' }, 500)

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json({ error: 'expected multipart/form-data' }, 400)
  }

  const audio = form.get('audio')
  const metaRaw = form.get('meta')
  if (!(audio instanceof File))
    return json({ error: 'missing audio file' }, 400)
  if (typeof metaRaw !== 'string') return json({ error: 'missing meta' }, 400)
  if (audio.size > MAX_AUDIO_BYTES) {
    return json({ error: 'audio too large (max 4 MB)' }, 413)
  }

  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(metaRaw) as Record<string, unknown>
  } catch {
    return json({ error: 'meta is not valid JSON' }, 400)
  }

  const rawById = meta.rawById
  if (
    !rawById ||
    typeof rawById !== 'object' ||
    Object.keys(rawById).length < MIN_PARAMS
  ) {
    return json({ error: 'meta.rawById must include the program params' }, 400)
  }
  const pitchMidi = Number(meta.pitchMidi)
  if (!Number.isFinite(pitchMidi)) {
    return json({ error: 'meta.pitchMidi is required' }, 400)
  }

  const ip = clientIp(req)
  if (await rateLimited(ip)) {
    return json({ error: 'rate limit exceeded — try again later' }, 429)
  }
  const tsToken = form.get('turnstileToken')
  if (!(await turnstileOk(typeof tsToken === 'string' ? tsToken : null, ip))) {
    return json({ error: 'captcha verification failed' }, 403)
  }

  const id = randomUUID()
  let ext = (audio.name.split('.').pop() || 'wav').toLowerCase()
  if (!(ext in AUDIO_TYPES)) ext = 'wav'

  const stored = await put(`contributions/${id}/audio.${ext}`, audio, {
    access: 'public',
    token,
    contentType: AUDIO_TYPES[ext],
  })

  const record = {
    id,
    audioUrl: stored.url,
    audioExt: ext,
    rawById,
    name:
      typeof meta.name === 'string' ? meta.name.slice(0, MAX_NAME_LEN) : null,
    pitchMidi,
    model:
      typeof meta.model === 'string' ? meta.model.slice(0, MAX_NAME_LEN) : null,
    engine:
      meta.engine === 'builtin' || meta.engine === 'gemini'
        ? meta.engine
        : null,
    rating:
      meta.rating === 'as-is' || meta.rating === 'adjusted'
        ? meta.rating
        : null,
    rationale:
      typeof meta.rationale === 'string' ? meta.rationale.slice(0, 800) : null,
    // Gemini's structured audio analysis — keep string fields only, length-capped.
    analysis:
      meta.analysis &&
      typeof meta.analysis === 'object' &&
      !Array.isArray(meta.analysis)
        ? Object.fromEntries(
            Object.entries(meta.analysis as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .slice(0, 12)
              .map(([k, v]) => [k.slice(0, 40), (v as string).slice(0, 500)]),
          )
        : null,
    promptVersion:
      typeof meta.promptVersion === 'string' ? meta.promptVersion : null,
    schemaVersion:
      typeof meta.schemaVersion === 'string' ? meta.schemaVersion : null,
    createdAt: new Date().toISOString(),
  }

  await put(`contributions/${id}/meta.json`, JSON.stringify(record, null, 2), {
    access: 'public',
    token,
    contentType: 'application/json',
  })

  return json({ id }, 200)
}
