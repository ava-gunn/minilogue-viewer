import { expect, it } from 'vitest'
import { hashProgBin } from './hash'

it('is deterministic for identical bytes', () => {
  expect(hashProgBin(new Uint8Array([1, 2, 3, 4]))).toBe(
    hashProgBin(new Uint8Array([1, 2, 3, 4])),
  )
})

it('changes when any byte changes', () => {
  const a = new Uint8Array(1024)
  const b = new Uint8Array(1024)
  b[500] = 1
  expect(hashProgBin(a)).not.toBe(hashProgBin(b))
})

it('returns a compact base36 string', () => {
  expect(hashProgBin(new Uint8Array([9, 9, 9]))).toMatch(/^[0-9a-z]+$/)
})
