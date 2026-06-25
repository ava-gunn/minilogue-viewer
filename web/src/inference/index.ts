import type { MinilogueXDPatch } from '../types/synth'
import { decodeToSamples } from './audio'
import { outputsToRawById, rawByIdToPatch } from './decode'
import { logMel } from './mel'
import { runModel } from './session'

/** Audio file -> raw Minilogue XD params by id, via the built-in ONNX model
 *  (decode -> mel -> onnx -> argmax/denormalize). The id-keyed form is what both the
 *  panel display (rawByIdToPatch) and the contribution upload consume. */
export async function matchAudioRawById(
  file: File,
): Promise<Record<string, number>> {
  const samples = await decodeToSamples(file)
  const mel = logMel(samples)
  const outputs = await runModel(mel)
  return outputsToRawById(outputs)
}

/** Audio file -> inferred Minilogue XD patch (built-in model). */
export async function matchAudioFile(file: File): Promise<MinilogueXDPatch> {
  return rawByIdToPatch(await matchAudioRawById(file))
}
