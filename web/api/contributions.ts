// GET /api/contributions — admin-only listing of submitted contributions, consumed by
// training/data/pull_contributions.py. Returns the metadata records (each includes a public
// audioUrl); the Blob token stays server-side.
// DELETE /api/contributions — admin-only cleanup, called by the puller after it has durably
// written the pulled samples locally. Body { ids: string[] }; deletes each contribution's
// audio + meta.json from Blob. Idempotent (deleting a gone id is a no-op).
// Both gate on the CONTRIB_ADMIN_TOKEN env var:  Authorization: Bearer <CONTRIB_ADMIN_TOKEN>

import { createHash, timingSafeEqual } from 'node:crypto'
import { del, list } from '@vercel/blob'

// Node.js runtime (the default): @vercel/blob needs Node modules the Edge runtime lacks.

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Constant-time compare: hash both sides to equal-length digests so timingSafeEqual can't
 *  throw on length and response time doesn't leak how many bytes of the token matched. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  )
}

export async function GET(req: Request): Promise<Response> {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  const admin = process.env.CONTRIB_ADMIN_TOKEN
  if (!token || !admin) return json({ error: 'storage not configured' }, 500)

  const auth = req.headers.get('authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${admin}`))
    return json({ error: 'unauthorized' }, 401)

  const records: unknown[] = []
  let cursor: string | undefined
  do {
    const page = await list({
      prefix: 'contributions/',
      token,
      cursor,
      limit: 1000,
    })
    const metaBlobs = page.blobs.filter((b) =>
      b.pathname.endsWith('/meta.json'),
    )
    const fetched = await Promise.all(
      metaBlobs.map((b) =>
        fetch(b.url)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ),
    )
    for (const rec of fetched) if (rec) records.push(rec)
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  return json({ count: records.length, contributions: records }, 200)
}

// Contribution ids are server-minted UUIDs; pin the shape so a request can't smuggle a prefix
// that escapes the contributions/ namespace.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

export async function DELETE(req: Request): Promise<Response> {
  const token = process.env.BLOB_READ_WRITE_TOKEN
  const admin = process.env.CONTRIB_ADMIN_TOKEN
  if (!token || !admin) return json({ error: 'storage not configured' }, 500)

  const auth = req.headers.get('authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${admin}`))
    return json({ error: 'unauthorized' }, 401)

  let ids: unknown
  try {
    ids = ((await req.json()) as { ids?: unknown }).ids
  } catch {
    return json({ error: 'expected JSON body { ids: string[] }' }, 400)
  }
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !ID_RE.test(id))
  ) {
    return json({ error: 'ids must be an array of contribution ids' }, 400)
  }
  if (ids.length === 0) return json({ deleted: 0, ids: [] }, 200)

  // List each contribution's prefix and delete what's there — so we drop the audio whatever its
  // extension, and an already-deleted id resolves to nothing (the puller retries cleanup, so
  // DELETE must be idempotent). Batches are bounded by what a single pull just ingested.
  const urls: string[] = []
  const deleted: string[] = []
  for (const id of ids as string[]) {
    const page = await list({
      prefix: `contributions/${id}/`,
      token,
      limit: 1000,
    })
    if (page.blobs.length) {
      urls.push(...page.blobs.map((b) => b.url))
      deleted.push(id)
    }
  }
  if (urls.length) await del(urls, { token })

  return json({ deleted: deleted.length, ids: deleted }, 200)
}
