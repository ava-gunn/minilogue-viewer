// onnxruntime-web session: loaded once, run on demand. WASM backend, single-threaded
// (no cross-origin isolation needed). The .wasm assets are served from /ort/ (copied by
// vite-plugin-static-copy); the model from /models/ (public/).

// CPU/wasm-only build (no WebGPU/JSEP). Its glue is bundled, so only the .wasm binary
// is fetched at runtime — see vite.config.ts (optimizeDeps.exclude keeps it inlined).
import * as ort from 'onnxruntime-web/wasm'
import { INPUT_NAME, N_FRAMES, N_MELS } from './contract'

ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
ort.env.wasm.numThreads = 1

export interface RawOutputs {
  continuous: Float32Array
  discrete: Float32Array
  boolean: Float32Array
}

let sessionPromise: Promise<ort.InferenceSession> | undefined

function load(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    const url = `${import.meta.env.BASE_URL}models/model.onnx`
    sessionPromise = ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
    })
  }
  return sessionPromise
}

export async function runModel(mel: Float32Array): Promise<RawOutputs> {
  const session = await load()
  const input = new ort.Tensor('float32', mel, [1, 1, N_MELS, N_FRAMES])
  const results = await session.run({ [INPUT_NAME]: input })
  return {
    continuous: results.continuous.data as Float32Array,
    discrete: results.discrete.data as Float32Array,
    boolean: results.boolean.data as Float32Array,
  }
}
