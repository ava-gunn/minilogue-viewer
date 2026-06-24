import type { MinilogueXDPatch } from '../types/synth'
import { decodeToSamples } from './audio'
import { outputsToPatch } from './decode'
import { logMel } from './mel'
import { runModel } from './session'

/** Audio file -> inferred Minilogue XD patch. Uses the Phase 2 dummy model for now;
 *  the pipeline (decode -> mel -> onnx -> RawPatch -> parsePatch) is the real one. */
export async function matchAudioFile(file: File): Promise<MinilogueXDPatch> {
  const samples = await decodeToSamples(file)
  const mel = logMel(samples)
  const outputs = await runModel(mel)
  return outputsToPatch(outputs)
}
