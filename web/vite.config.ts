import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const ortDir = resolve(root, 'public/ort')

// Serve /ort/* as raw static assets in dev, ahead of Vite's transform middleware —
// which otherwise claims the .mjs glue ort loads at runtime and fails to resolve it
// (the ?import request resolves against the project root, not public/). In a build,
// public/ort is copied into dist/ as-is, so no special handling is needed there.
const serveOrtRuntime = (): Plugin => ({
  name: 'serve-ort-runtime',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? '').split('?')[0]
      if (!path.startsWith('/ort/')) return next()
      try {
        const body = readFileSync(resolve(ortDir, path.slice('/ort/'.length)))
        res.setHeader(
          'Content-Type',
          path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        )
        res.end(body)
      } catch {
        next()
      }
    })
  },
})

export default defineConfig({
  server: { port: 5173, strictPort: true },
  // Load .env from the repo root (one .env for web + server + python). Only VITE_-prefixed vars
  // reach the client; the server/python secrets in that file stay unexposed.
  envDir: resolve(root, '..'),
  // Single page (index.html). The re-synthesis form lives here too but its controller + deps
  // (ONNX, @google/genai, Turnstile) load as a separate chunk on the first Resynthesis click.
  build: {
    // No inline modulepreload polyfill — keeps the prod HTML free of inline scripts so the
    // strict script-src CSP (vercel.json) holds. Safe: Web MIDI already limits this app to
    // modern Chromium, which supports modulepreload natively.
    modulePreload: { polyfill: false },
  },
  // Keep ort out of dep pre-bundling so esbuild doesn't strip the @vite-ignore on its
  // runtime wasm-glue import.
  optimizeDeps: { exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'] },
  plugins: [serveOrtRuntime()],
})
