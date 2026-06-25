import { emit, on } from './events/bus'
import { matchAudioFile } from './inference'
import { initEffects } from './sections/effects'
import { initLibrary, initLoad } from './sections/load'
import { initMidiStatus } from './sections/midi-status'
import { initShared } from './sections/shared'
import { createLivePatch } from './services/live-patch'
import { connectMidi } from './services/midi'

/** Wire the app: file/audio loading + live MIDI → parse → panel updates. */
export function initApp(): void {
  initLoad()
  initAudio()
  initLibrary()
  initShared()
  initEffects()
  initLive()
}

/** A dropped/browsed audio file → sound-matched patch → events. */
function initAudio(): void {
  on('audio:dropped', async ({ file }) => {
    try {
      const patch = await matchAudioFile(file)
      emit('patch:load', { patch, index: 0, total: 1 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('file:error', {
        message: `Could not match ${file.name}: ${message}`,
      })
    }
  })
}

/** Detect a connected minilogue xd and mirror its live control positions. */
function initLive(): void {
  initMidiStatus()
  const live = createLivePatch()
  void (async () => {
    const midi = await connectMidi({
      onDump: live.loadDump,
      onPoll: live.pollDump,
      onControlChange: live.controlChange,
    })
    const btn = document.getElementById('midi-refresh')
    if (!btn) return
    if (midi) btn.addEventListener('click', () => midi.refresh())
    else btn.setAttribute('hidden', '')
  })()
}
