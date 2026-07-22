// One Web-MIDI connection shared across the app (never open Web MIDI twice). The current program
// is captured as `template` for load-to-hardware + the "Mine's better" feedback.

import { connectBridge } from './bridge-midi'
import { createLivePatch } from './live-patch'
import { connectMidi, type MidiController, type MidiHandlers } from './midi'

export interface SynthLink {
  /** Re-request the current program (the viewer's Refresh button + program changes). */
  refresh: () => void
  /** Load a 1024-byte prog_bin into the synth's edit buffer; false if no output port. */
  sendProgram: (prog: Uint8Array) => boolean
  /** The most recent program dumped from the synth (its live edit buffer), or undefined. */
  getTemplate: () => Uint8Array | undefined
  /** Force a fresh current-program dump and resolve with it — every param at its actual hardware
      value (not the last ≤1.5s poll). Used by "Mine's better" so the params you didn't touch carry
      the synth's real values. Falls back to the last known program on timeout / no connection. */
  requestDump: () => Promise<Uint8Array | undefined>
}

// The 12-byte program name lives at prog_bin offset 4. A change there means a *different* program
// was selected on the synth — not just a knob edit (which keeps the name) — so the poll should
// re-render. Comparing the name (not every byte) keeps in-place edits from clobbering the live
// needles every 1.5s.
const NAME_START = 4
const NAME_END = 16
function sameProgram(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a) return false
  for (let i = NAME_START; i < NAME_END; i++) if (a[i] !== b[i]) return false
  return true
}

export function createSynthLink(): SynthLink {
  const live = createLivePatch()
  let template: Uint8Array | undefined
  let midi: MidiController | undefined
  const dumpWaiters: Array<(prog: Uint8Array) => void> = []

  // Every full dump (connect/refresh or the 1.5s poll) refreshes the captured template and
  // resolves any pending requestDump() — both carry the synth's complete live edit buffer.
  const settle = (prog: Uint8Array): void => {
    template = prog
    while (dumpWaiters.length) dumpWaiters.shift()?.(prog)
  }

  const handlers: MidiHandlers = {
    // Panel is last-load-wins (file / synth dump / generated patch).
    onDump: (prog) => {
      live.loadDump(prog)
      settle(prog)
    },
    // Poll refreshes the captured program only — don't re-emit patch:load, so a generated/loaded
    // patch isn't clobbered. Exception: if the *program itself* changed on the hardware (a new
    // program whose Program Change wasn't sent, or that lost the pendingMode race), render it.
    onPoll: (prog) => {
      if (!sameProgram(template, prog)) live.loadDump(prog)
      settle(prog)
    },
    onControlChange: live.controlChange,
  }

  void (async () => {
    // Web MIDI in a capable browser; else the local bridge (Ableton WKWebView, Safari/iOS).
    midi =
      (await connectMidi(handlers)) ??
      (await connectBridge(handlers)) ??
      undefined
  })()

  return {
    refresh: () => midi?.refresh(),
    sendProgram: (prog) => midi?.sendProgram(prog) ?? false,
    getTemplate: () => template,
    requestDump: () =>
      new Promise<Uint8Array | undefined>((resolve) => {
        if (!midi) {
          resolve(template)
          return
        }
        const waiter = (prog: Uint8Array): void => {
          clearTimeout(timer)
          resolve(prog)
        }
        const timer = setTimeout(() => {
          const i = dumpWaiters.indexOf(waiter)
          if (i >= 0) dumpWaiters.splice(i, 1)
          resolve(template) // no fresh dump in time — fall back to the last known program
        }, 1200)
        dumpWaiters.push(waiter)
        midi.refresh()
      }),
  }
}
