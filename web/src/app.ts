import { initEffects } from './sections/effects'
import { initLibrary, initLoad } from './sections/load'
import { initMidiStatus } from './sections/midi-status'
import { initShared } from './sections/shared'
import type { SynthLink } from './services/synth-link'

/** Wire the always-loaded viewer: patch-file/library loading + live MIDI mirroring. Audio
 *  re-synthesis (ONNX / Gemini) is lazy-loaded separately on the Resynthesis button, so nothing
 *  here pulls onnxruntime into the initial bundle. */
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
