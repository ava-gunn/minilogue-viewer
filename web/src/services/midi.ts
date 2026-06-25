// Web MIDI transport for the minilogue xd: requests the current-program SysEx
// dump and routes incoming SysEx / Control Change / Program Change. Knows nothing
// about patches — it hands raw program bytes and CC values to the caller.

import { emit } from '../events/bus'
import type { AppEventMap } from '../events/types'
import {
  currentProgramDumpRequest,
  decodeCurrentProgramDump,
  isCurrentProgramDump,
} from '../parser/korg-sysex'

export interface MidiHandlers {
  /** Decoded 1024-byte prog_bin from a current-program dump. seedLive is false
      when the dump was triggered by a program change (live needles stay put). */
  onDump: (prog: Uint8Array, seedLive: boolean) => void
  /** A Control Change (controller, value), each 0..127. */
  onControlChange: (controller: number, value: number) => void
}

export interface MidiController {
  /** Re-request the current program (debounced). */
  refresh: () => void
}

const DEVICE_RE = /minilogue\s*xd/i
const SOUND_RE = /sound/i

type MidiStatus = AppEventMap['midi:status']

function emitStatus(
  state: MidiStatus['state'],
  opts: { device?: string; detail?: string } = {},
): void {
  const payload: MidiStatus = { state }
  if (opts.device !== undefined) payload.device = opts.device
  if (opts.detail !== undefined) payload.detail = opts.detail
  emit('midi:status', payload)
}

/** Connect to Web MIDI, wire routing, and start mirroring. Emits 'midi:status'
    throughout; returns null when MIDI is unavailable or access was denied. */
export async function connectMidi(
  handlers: MidiHandlers,
): Promise<MidiController | null> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.requestMIDIAccess !== 'function'
  ) {
    emitStatus('unsupported')
    return null
  }

  emitStatus('requesting')
  let access: MIDIAccess
  try {
    access = await navigator.requestMIDIAccess({ sysex: true })
  } catch (err) {
    emitStatus('denied', {
      detail: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  // Whether the next dump should also reset the live layer. True for connect /
  // manual refresh; set false by a program change.
  let pendingSeedLive = true

  function deviceName(): string | undefined {
    const ports = [...access.inputs.values(), ...access.outputs.values()]
    return ports.find((p) => DEVICE_RE.test(p.name ?? ''))?.name ?? undefined
  }

  function sendRequest(): void {
    const all = [...access.outputs.values()]
    const named = all.filter((p) => DEVICE_RE.test(p.name ?? ''))
    const pool = named.length ? named : all
    const sound = pool.filter((p) => SOUND_RE.test(p.name ?? ''))
    // Prefer the SOUND port (it answers program dumps); broadcast all 16 channels
    // since the synth only replies on its global one.
    for (const out of sound.length ? sound : pool) {
      for (let ch = 0; ch < 16; ch++) {
        out.send(Array.from(currentProgramDumpRequest(ch)))
      }
    }
  }

  function refresh(seedLive = true): void {
    pendingSeedLive = seedLive
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(sendRequest, 120)
  }

  function handleMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length === 0) return
    if (data[0] === 0xf0) {
      if (isCurrentProgramDump(data)) {
        try {
          const seedLive = pendingSeedLive
          pendingSeedLive = true
          handlers.onDump(decodeCurrentProgramDump(data), seedLive)
        } catch (err) {
          emit('file:error', {
            message: `Bad program dump: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
      return
    }
    const kind = data[0] & 0xf0
    if (kind === 0xb0 && data.length >= 3) {
      handlers.onControlChange(data[1], data[2])
    } else if (kind === 0xc0) {
      // Program change → re-pull program values, but leave the live (synth)
      // needles where they are: only the program needles should jump.
      refresh(false)
    }
  }

  function attachInputs(): void {
    for (const input of access.inputs.values()) {
      input.onmidimessage = handleMessage
    }
  }

  function updateStatus(): void {
    const name = deviceName()
    if (name !== undefined) emitStatus('connected', { device: name })
    else emitStatus('no-device')
  }

  access.onstatechange = () => {
    attachInputs()
    updateStatus()
    refresh()
  }

  attachInputs()
  updateStatus()
  refresh()

  return { refresh }
}
