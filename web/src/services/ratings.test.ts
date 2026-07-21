import { beforeEach, expect, it, vi } from 'vitest'

// The ratings module caches on first access, so reset the module registry per test to exercise the
// one-time hydration path (localStorage + the host-injected window.__XD_RATINGS__ seed).
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  window.__XD_RATINGS__ = undefined
})

it('hydrates from the host-injected seed (Ableton path)', async () => {
  window.__XD_RATINGS__ = { aaa: 4, bbb: 2 }
  const { getRating, getAllRatings } = await import('./ratings')
  expect(getRating('aaa')).toBe(4)
  expect(getAllRatings()).toEqual({ aaa: 4, bbb: 2 })
})

it('ignores out-of-range / non-integer seed values', async () => {
  window.__XD_RATINGS__ = {
    good: 3,
    tooHigh: 9,
    notNum: 'x' as unknown as number,
  }
  const { getAllRatings } = await import('./ratings')
  expect(getAllRatings()).toEqual({ good: 3 })
})

it('getAllRatings reflects set and clear', async () => {
  const { setRating, getAllRatings } = await import('./ratings')
  setRating('k', 3)
  expect(getAllRatings().k).toBe(3)
  setRating('k', 0)
  expect(getAllRatings().k).toBeUndefined()
})

it('persists to localStorage (web-app path)', async () => {
  const { setRating } = await import('./ratings')
  setRating('p', 5)
  expect(
    JSON.parse(localStorage.getItem('xd-patch-ratings-v1') ?? '{}').p,
  ).toBe(5)
})
