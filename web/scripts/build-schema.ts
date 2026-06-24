// Emits the shared parameter + audio schema to ../../schema/ from the TS source of
// truth in src/parser/param-spec.ts. Run with `pnpm build:schema`.
// The committed JSON is guarded against drift by src/parser/schema-gen.test.ts.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildAudioSchema, buildParamsSchema } from '../src/parser/param-spec'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = resolve(here, '../../schema')

const write = (name: string, data: unknown): void => {
  const file = resolve(schemaDir, name)
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`wrote ${file}`)
}

function main(): void {
  mkdirSync(schemaDir, { recursive: true })
  write('minilogue-xd.params.json', buildParamsSchema())
  write('audio.json', buildAudioSchema())
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
