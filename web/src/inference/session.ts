import * as ort from 'onnxruntime-web/wasm'
import { INPUT_NAME, N_FRAMES, N_MELS, OUTPUT_NAMES } from './contract'

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
  for (const name of OUTPUT_NAMES) {
    if (!results[name]) {
      throw new Error(
        `model output "${name}" missing (have: ${Object.keys(results).join(', ')}) — wrong model?`,
      )
    }
  }
  return {
    continuous: results.continuous.data as Float32Array,
    discrete: results.discrete.data as Float32Array,
    boolean: results.boolean.data as Float32Array,
  }
}
