// Copy onnxruntime-web's wasm runtime into public/ort/ so Vite serves it (dev: raw
// from public, ignoring the ?import query that breaks virtually-copied files; build:
// public/ is copied into dist/). Wired to postinstall; gitignored (13 MB .wasm).

import { cpSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../node_modules/onnxruntime-web/dist')
const dest = resolve(here, '../public/ort')

// The CPU/wasm-only build (onnxruntime-web/wasm) loads just these two at runtime.
const files = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']

mkdirSync(dest, { recursive: true })
for (const f of files) cpSync(resolve(src, f), resolve(dest, f))
console.log(`copied ort runtime (${files.length} files) to ${dest}`)
