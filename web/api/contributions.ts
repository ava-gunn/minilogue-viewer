// GET /api/contributions — admin-only listing of submitted contributions, consumed by
// training/data/pull_contributions.py. Returns the metadata records (each includes a public
// audioUrl); the Blob token stays server-side. Gate with the CONTRIB_ADMIN_TOKEN env var:
//   Authorization: Bearer <CONTRIB_ADMIN_TOKEN>

import { createHash, timingSafeEqual } from 'node:crypto'
import { list } from '@vercel/blob'

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
