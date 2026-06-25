// Web MIDI transport for the minilogue xd: requests the current-program SysEx
// dump and routes incoming SysEx / Control Change / Program Change. Knows nothing
// about patches — it hands raw program bytes and CC values to the caller.

import { emit } from '../events/bus'
import type { AppEventMap } from '../events/types'
import {
  currentProgramDump,
  currentProgramDumpRequest,
  decodeCurrentProgramDump,
  isCurrentProgramDump,
} from '../parser/korg-sysex'

export interface MidiHandlers {
  /** Decoded 1024-byte prog_bin from a current-program dump. seedLive is false
      when the dump was triggered by a program change (live needles stay put). */
  onDump: (prog: Uint8Array, seedLive: boolean) => void
  /** A periodic poll dump — refresh only params the synth doesn't send as CC
      (e.g. voice mode), without disturbing the CC-tracked needles. */
  onPoll: (prog: Uint8Array) => void
  /** A Control Change (controller, value), each 0..127. */
  onControlChange: (controller: number, value: number) => void
}

export interface MidiController {
  /** Re-request the current program (debounced). */
  refresh: () => void
  /** Load a 1024-byte prog_bin into the synth's edit buffer. Returns false if no
      output port is available. */
  sendProgram: (prog: Uint8Array) => boolean
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
  // What the next dump response is for: 'full' = connect/refresh (seed live too),
  // 'program' = program change (leave live needles), 'poll' = periodic SysEx-only
  // refresh (voice mode etc.).
  let pendingMode: 'full' | 'program' | 'poll' = 'full'

  function deviceName(): string | undefined {
    const ports = [...access.inputs.values(), ...access.outputs.values()]
    return ports.find((p) => DEVICE_RE.test(p.name ?? ''))?.name ?? undefined
  }

  // Prefer the SOUND port (it answers/loads program dumps), else any named minilogue
  // xd port, else every output. The synth only acts on its global channel, so callers
  // broadcast all 16.
  function targetOutputs() {
    const all = [...access.outputs.values()]
    const named = all.filter((p) => DEVICE_RE.test(p.name ?? ''))
    const pool = named.length ? named : all
    const sound = pool.filter((p) => SOUND_RE.test(p.name ?? ''))
    return sound.length ? sound : pool
  }

  function sendRequest(): void {
    for (const out of targetOutputs()) {
      for (let ch = 0; ch < 16; ch++) {
        out.send(Array.from(currentProgramDumpRequest(ch)))
      }
    }
  }

  function sendProgram(prog: Uint8Array): boolean {
    const outs = targetOutputs()
    for (const out of outs) {
      for (let ch = 0; ch < 16; ch++) {
        out.send(Array.from(currentProgramDump(prog, ch)))
      }
    }
    return outs.length > 0
  }

  function refresh(seedLive = true): void {
    pendingMode = seedLive ? 'full' : 'program'
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(sendRequest, 120)
  }

  // Web MIDI may split a long SysEx dump (≈1179 bytes) across several events, so
  // reassemble from F0 to F7 before decoding instead of treating each event as a
  // complete message (which truncated the dump → "decoded dump too short").
  const MAX_SYSEX = 8192
  let sysex: number[] = []
  let inSysex = false

  function handleSysex(msg: Uint8Array): void {
    if (!isCurrentProgramDump(msg)) return // ignore other SysEx (identity reply…)
    try {
      const mode = pendingMode
      pendingMode = 'full'
      const prog = decodeCurrentProgramDump(msg)
      if (mode === 'poll') handlers.onPoll(prog)
      else handlers.onDump(prog, mode === 'full')
    } catch (err) {
      emit('file:error', {
        message: `Bad program dump: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  function handleMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length === 0) return

    if (data[0] === 0xf0 || inSysex) {
      // Standalone real-time bytes (clock / active sensing) can interleave a
      // fragmented SysEx — don't fold them into the buffer.
      if (inSysex && data[0] >= 0xf8) return
      if (data[0] === 0xf0) {
        sysex = []
        inSysex = true
      }
      for (let i = 0; i < data.length; i++) sysex.push(data[i])
      if (sysex[sysex.length - 1] === 0xf7) {
        const msg = new Uint8Array(sysex)
        sysex = []
        inSysex = false
        handleSysex(msg)
      } else if (sysex.length > MAX_SYSEX) {
        sysex = [] // runaway / lost terminator — drop it
        inSysex = false
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

  // Poll the current program so SysEx-only params (voice mode) track the synth,
  // which doesn't transmit them as CC. No-ops when no device is connected.
  setInterval(() => {
    pendingMode = 'poll'
    sendRequest()
  }, 1500)

  return { refresh, sendProgram }
}
