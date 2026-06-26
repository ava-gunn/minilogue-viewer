// One Web-MIDI connection for the whole app. The viewer mirrors the connected synth onto the
// panel (live needles) and the (lazy-loaded) resynth form loads patches to the hardware — both
// share this single connection so we never open Web MIDI twice. The current program is captured
// as `template` for load-to-hardware + the "Mine's better" feedback.

import { createLivePatch } from './live-patch'
import { connectMidi, type MidiController } from './midi'

export interface SynthLink {
  /** Re-request the current program (the viewer's Refresh button + program changes). */
  refresh: () => void
  /** Load a 1024-byte prog_bin into the synth's edit buffer; false if no output port. */
  sendProgram: (prog: Uint8Array) => boolean
  /** The most recent program dumped from the synth (its live edit buffer), or undefined. */
  getTemplate: () => Uint8Array | undefined
}

export function createSynthLink(): SynthLink {
  const live = createLivePatch()
  let template: Uint8Array | undefined
  let midi: MidiController | undefined

  void (async () => {
    midi =
      (await connectMidi({
        // Show the synth's current program on the panel and seed the live baseline; capture it
        // for load-to-hardware. Panel is last-load-wins (file / synth dump / generated patch).
        onDump: (prog) => {
          live.loadDump(prog)
          template = prog
        },
        // Periodic poll: just refresh the captured program (live.pollDump is a no-op — needles
        // update only from CCs); don't re-emit patch:load so a generated patch isn't clobbered.
        onPoll: (prog) => {
          template = prog
        },
        onControlChange: live.controlChange,
      })) ?? undefined
  })()

  return {
    refresh: () => midi?.refresh(),
    sendProgram: (prog) => midi?.sendProgram(prog) ?? false,
    getTemplate: () => template,
  }
}
