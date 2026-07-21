// Per-patch star ratings (0–5), keyed by a prog_bin content hash (see parser/hash). Persisted two
// ways: a localStorage JSON map in the web app, and — in the Ableton extension, where the modal's
// opaque data:-URL origin blocks localStorage — a host-side file. There the host seeds prior ratings
// into `window.__XD_RATINGS__` before the bundle runs and persists the map (getAllRatings) that the
// host-bridge hands back on close.

declare global {
  interface Window {
    __XD_RATINGS__?: Record<string, number> | undefined
  }
}

const STORAGE_KEY = 'xd-patch-ratings-v1'

export const MAX_STARS = 5

let cache: Record<string, number> | null = null

function loaded(): Record<string, number> {
  if (cache) return cache
  cache = {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const n = Number(v)
        if (Number.isInteger(n) && n >= 1 && n <= MAX_STARS) cache[k] = n
      }
    }
  } catch {
    // no/blocked storage (e.g. the Ableton data:-URL WebView) — falls through to the host seed
  }
  // Host-injected seed (Ableton extension): prior ratings the host wrote before the bundle ran.
  const injected = window.__XD_RATINGS__
  if (injected && typeof injected === 'object') {
    for (const [k, v] of Object.entries(injected)) {
      const n = Number(v)
      if (Number.isInteger(n) && n >= 1 && n <= MAX_STARS) cache[k] = n
    }
  }
  return cache
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded()))
  } catch {
    // best-effort
  }
}

/** Current rating for a key, or 0 (unrated). */
export function getRating(key: string): number {
  return loaded()[key] ?? 0
}

/** Set a rating (clamped 0–5); 0 clears it. Persists best-effort. */
export function setRating(key: string, stars: number): number {
  const n = Math.max(0, Math.min(MAX_STARS, Math.round(stars)))
  const map = loaded()
  if (n === 0) delete map[key]
  else map[key] = n
  persist()
  return n
}

/** The full ratings map — the Ableton host bridge sends this back on close to persist to disk. */
export function getAllRatings(): Record<string, number> {
  return { ...loaded() }
}
