// Web MIDI transport: requests the current-program SysEx dump and routes incoming
// SysEx / Control Change / Program Change. Hands raw bytes to the caller; knows nothing about patches.

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
  /** Stop the background poll + any pending refresh and release timers. */
  dispose: () => void
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
  // What the NEXT requested dump is for: 'full' = connect/refresh (seed live), 'program' = program
  // change (leave live needles), 'poll' = periodic SysEx-only refresh, 'idle' = nothing requested.
  // A dump consumes the mode then resets to 'idle', so a duplicate reply (the dump can arrive on
  // more than one input port) or an unsolicited dump is ignored.
  let pendingMode: 'full' | 'program' | 'poll' | 'idle' = 'idle'

  // Liveness from real MIDI activity, NOT port.state / statechange (unreliable for power-off;
  // Firefox keeps a switched-off port listed as 'connected' and may not fire statechange). A
  // powered-on minilogue xd streams Active Sensing, so silence past ACTIVITY_TIMEOUT means it's off.
  const ACTIVITY_TIMEOUT = 4000
  let lastSeen = 0
  let lastState: MidiStatus['state'] | '' = ''
  let lastDevice: string | undefined
  const attachedInputs = new WeakSet<MIDIInput>()

  // Identify by port name only; liveness is decided by MIDI activity (port.state is untrusted).
  function deviceName(): string | undefined {
    const ports = [...access.inputs.values(), ...access.outputs.values()]
    return ports.find((p) => DEVICE_RE.test(p.name ?? ''))?.name ?? undefined
  }

  // Prefer the SOUND port (answers/loads program dumps), else any named minilogue xd port, else
  // every output. The synth only acts on its global channel, so callers broadcast all 16.
  function targetOutputs() {
    const all = [...access.outputs.values()]
    const named = all.filter((p) => DEVICE_RE.test(p.name ?? ''))
    const pool = named.length ? named : all
    const sound = pool.filter((p) => SOUND_RE.test(p.name ?? ''))
    return sound.length ? sound : pool
  }

  function sendRequest(): void {
    for (const out of targetOutputs()) {
      try {
        for (let ch = 0; ch < 16; ch++) {
          out.send(Array.from(currentProgramDumpRequest(ch)))
        }
      } catch {
        // A port can vanish between enumeration and send (powered-off synth lingering in the
        // map, esp. Firefox); the activity watchdog reports it as no-device.
      }
    }
  }

  function sendProgram(prog: Uint8Array): boolean {
    const outs = targetOutputs()
    for (const out of outs) {
      try {
        for (let ch = 0; ch < 16; ch++) {
          out.send(Array.from(currentProgramDump(prog, ch)))
        }
      } catch {
        // ignore a port that disappeared mid-send
      }
    }
    return outs.length > 0
  }

  function refresh(seedLive = true): void {
    pendingMode = seedLive ? 'full' : 'program'
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(sendRequest, 120)
  }

  const MAX_SYSEX = 8192

  function handleSysex(msg: Uint8Array): void {
    if (!isCurrentProgramDump(msg)) return // ignore other SysEx (identity reply…)
    // Consume the mode, then reset to 'idle' so a duplicate or unsolicited dump can't re-seed.
    const mode = pendingMode
    pendingMode = 'idle'
    if (mode === 'idle') return
    try {
      const prog = decodeCurrentProgramDump(msg)
      if (mode === 'poll') handlers.onPoll(prog)
      else handlers.onDump(prog, mode === 'full')
    } catch (err) {
      // A dump can arrive corrupt (lost/interleaved byte); the 1.5s poll re-requests, so recover silently.
      console.warn(
        `[midi] ignoring bad program dump: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Web MIDI may split a long SysEx dump (≈1179 bytes) across events, so reassemble F0→F7 before
  // decoding. State is PER INPUT: the minilogue xd exposes multiple input ports (SOUND, KBD/KNOB);
  // a single shared buffer let traffic on one port interleave a dump on another → "decoded dump
  // too short". A non-real-time status byte mid-SysEx abandons the partial buffer (lost terminator).
  function makeMessageHandler(): (e: MIDIMessageEvent) => void {
    let sysex: number[] = []
    let inSysex = false

    const finish = (): void => {
      const msg = new Uint8Array(sysex)
      sysex = []
      inSysex = false
      handleSysex(msg)
    }

    // Reassemble F0…F7 byte by byte, transparent to System Real-Time bytes (0xf8–0xff, e.g. the
    // Active Sensing the synth streams). Those can interleave a dump fragment; appending them
    // corrupts the payload and dropping the whole fragment loses dump bytes → "decoded dump too short".
    const consumeSysex = (data: Uint8Array): void => {
      for (let i = 0; i < data.length; i++) {
        const b = data[i]
        if (b >= 0xf8) continue // real-time — invisible to the SysEx stream
        if (b === 0xf0) {
          sysex = [b] // (re)start
          inSysex = true
        } else if (b === 0xf7) {
          if (inSysex) {
            sysex.push(b)
            finish()
          }
        } else if (b >= 0x80) {
          // A fresh channel/system status mid-SysEx → the dump lost its terminator; abandon it.
          sysex = []
          inSysex = false
        } else if (inSysex) {
          sysex.push(b)
          if (sysex.length > MAX_SYSEX) {
            sysex = [] // runaway / lost terminator — drop it
            inSysex = false
          }
        }
      }
    }

    return (e: MIDIMessageEvent): void => {
      const data = e.data
      if (!data || data.length === 0) return
      // Any inbound byte is the synth's heartbeat; the watchdog handles the silence → no-device edge.
      lastSeen = Date.now()
      if (lastState !== 'connected') evaluateStatus()

      const status = data[0]
      if (inSysex || status === 0xf0) {
        consumeSysex(data)
        return
      }

      // Non-SysEx channel message — Web MIDI delivers each as one complete event.
      const kind = status & 0xf0
      if (kind === 0xb0 && data.length >= 3) {
        handlers.onControlChange(data[1], data[2])
      } else if (kind === 0xc0) {
        // Program change → re-pull program values but leave the live needles (seedLive false).
        refresh(false)
      }
    }
  }

  // Idempotent: the poll re-scans for ports that appeared without a statechange (Firefox) without
  // resetting an in-flight reassembly.
  function attachInputs(): void {
    for (const input of access.inputs.values()) {
      if (attachedInputs.has(input)) continue
      attachedInputs.add(input)
      input.onmidimessage = makeMessageHandler()
    }
  }

  // Connected iff a minilogue xd port is present AND heard from within ACTIVITY_TIMEOUT. Deduped.
  function evaluateStatus(): void {
    const name = deviceName()
    const live = name !== undefined && Date.now() - lastSeen < ACTIVITY_TIMEOUT
    const state: MidiStatus['state'] = live ? 'connected' : 'no-device'
    const device = live ? name : undefined
    if (state === lastState && device === lastDevice) return
    lastState = state
    lastDevice = device
    emitStatus(state, device !== undefined ? { device } : {})
  }

  // statechange only re-scans + re-pulls; it does NOT drive status (unreliable for power-off).
  // The activity watchdog owns connected/no-device.
  access.onstatechange = () => {
    attachInputs()
    refresh()
  }

  attachInputs()
  refresh()

  // Poll so SysEx-only params (voice mode) track the synth, which doesn't transmit them as CC.
  // Also re-scans for late-appearing ports.
  const pollInterval = setInterval(() => {
    attachInputs()
    pendingMode = 'poll'
    sendRequest()
  }, 1500)

  // Liveness watchdog: drops to no-device once the synth goes silent.
  const statusInterval = setInterval(evaluateStatus, 1000)

  function dispose(): void {
    clearInterval(pollInterval)
    clearInterval(statusInterval)
    if (refreshTimer) clearTimeout(refreshTimer)
  }

  return { refresh, sendProgram, dispose }
}
