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
  // Two entry points: the file viewer (index.html) and the re-synthesis view
  // (resynth.html). cleanUrls (vercel.json) serves the latter at /resynth.
  build: {
    // No inline modulepreload polyfill — keeps the prod HTML free of inline scripts so the
    // strict script-src CSP (vercel.json) holds. Safe: Web MIDI already limits this app to
    // modern Chromium, which supports modulepreload natively.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        resynth: resolve(root, 'resynth.html'),
      },
    },
  },
  // Keep ort out of dep pre-bundling so esbuild doesn't strip the @vite-ignore on its
  // runtime wasm-glue import.
  optimizeDeps: { exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'] },
  plugins: [serveOrtRuntime()],
})
