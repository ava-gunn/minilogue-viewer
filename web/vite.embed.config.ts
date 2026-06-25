import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const root = dirname(fileURLToPath(import.meta.url))

// Viewer-only single-file build for the Ableton extension: JS + CSS + assets are all inlined
// into one self-contained embed.html with no external requests, so it runs offline from a
// data: URL inside Live's WebView. No ONNX/inference is imported, so the bundle stays small.
export default defineConfig({
  root,
  // The single file inlines everything, so don't copy public/ (ort wasm, models) — the
  // output is just embed.html.
  publicDir: false,
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { input: resolve(root, 'embed.html') },
  },
})
