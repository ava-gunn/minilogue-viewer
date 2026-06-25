// Local verify-and-tune bridge. When the app runs on localhost, a thumbs-up POSTs the
// source audio + predicted params to the on-machine daemon (training/daemon.py), which
// loads the patch on the connected XD, records, scores the resynthesis, and — if it
// matches — promotes it to the verified training set (retraining the built-in model in
// batches). In production this path is skipped in favor of the remote contribution.

import type { Engine } from './contribute'

const DAEMON = 'http://127.0.0.1:8753'

export const isLocalhost = (): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

export interface VerifyResult {
  status: 'verified' | 'review' | 'rejected'
  mel_l1: number
  weight: number
  promoted: boolean
  verified_total: number
}

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file) // handles any size; strip the data: prefix
  })

/** POST a liked patch to the local daemon to verify it on the real XD + fold it into
 *  training. Rejects if the daemon isn't reachable (start it with `pnpm daemon:start`). */
export async function verifyOnHardware(opts: {
  file: File
  rawById: Record<string, number>
  pitchMidi: number
  engine: Engine
}): Promise<VerifyResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Optional shared token — set VITE_DAEMON_TOKEN to match the daemon's --token/DAEMON_TOKEN.
  const token = (import.meta.env as Record<string, string | undefined>)
    .VITE_DAEMON_TOKEN
  if (token) headers['X-Daemon-Token'] = token
  const res = await fetch(`${DAEMON}/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      audio: await toBase64(opts.file),
      ext: opts.file.name.split('.').pop()?.toLowerCase() || 'wav',
      rawById: opts.rawById,
      pitch: opts.pitchMidi,
      engine: opts.engine, // provenance: built-in or gemini proposed these params
    }),
  })
  if (!res.ok) throw new Error(`daemon responded ${res.status}`)
  return res.json() as Promise<VerifyResult>
}
