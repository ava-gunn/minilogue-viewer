import { initEffects } from './sections/effects'
import { initLibrary, initLoad } from './sections/load'
import { initMidiStatus } from './sections/midi-status'
import { initShared } from './sections/shared'
import type { SynthLink } from './services/synth-link'

// Resynthesis (ONNX / Gemini) is lazy-loaded separately, so nothing here pulls onnxruntime into the initial bundle.
export function initViewer(link: SynthLink): void {
  initLoad()
  initLibrary()
  initShared()
  initEffects()
  initMidiStatus()
  document
    .getElementById('midi-refresh')
    ?.addEventListener('click', () => link.refresh())
}
