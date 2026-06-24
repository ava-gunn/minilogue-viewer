import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5173, strictPort: true },
  // ort's wasm runtime is served from /ort/ (public/ort, populated by
  // scripts/copy-ort.mjs). Exclude it from dep pre-bundling so esbuild doesn't rewrite
  // the bundled glue's loader into an unresolvable dynamic import.
  optimizeDeps: { exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'] },
})
