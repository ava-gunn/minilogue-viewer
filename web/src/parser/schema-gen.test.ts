import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readRawPatch } from './binary'
import { buildAudioSchema, buildParamsSchema, PARAM_SPEC } from './param-spec'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = resolve(here, '../../../schema')
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(schemaDir, name), 'utf8'))

describe('committed schema matches the generator (drift guard)', () => {
  it('minilogue-xd.params.json is up to date', () => {
    expect(readJson('minilogue-xd.params.json')).toEqual(buildParamsSchema())
  })

  it('audio.json is up to date', () => {
    expect(readJson('audio.json')).toEqual(buildAudioSchema())
  })

  it('has unique ids and fields', () => {
    const ids = PARAM_SPEC.map((s) => s.id)
    const fields = PARAM_SPEC.map((s) => s.field)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(fields).size).toBe(fields.length)
  })
})

// Prove every spec entry's offset + bit width agree with the binary reader: write a
// sentinel at the declared offset and confirm readRawPatch surfaces it on the field.
// A fresh zeroed buffer per entry means a mis-wired offset reads 0 and fails.
const progBuffer = (): Uint8Array => {
  const b = new Uint8Array(1024)
  b.set([0x50, 0x52, 0x4f, 0x47], 0) // 'PROG'
  return b
}

describe('param spec offsets match the binary reader', () => {
  for (const spec of PARAM_SPEC) {
    it(`${spec.id} @${spec.offset} (${spec.bitWidth}-bit)`, () => {
      const buf = progBuffer()
      let expected: number
      if (spec.bitWidth === 10) {
        expected = 677 // 0b1010100101 — exercises both bytes within 10 bits
        buf[spec.offset] = expected & 0xff
        buf[spec.offset + 1] = (expected >> 8) & 0xff
      } else {
        expected = 0xa5
        buf[spec.offset] = expected
      }
      expect(readRawPatch(buf)[spec.field]).toBe(expected)
    })
  }
})
