// MIDI transport over the local WebSocket bridge (bridge/bridge.py) — a drop-in alternative to the
// Web MIDI transport for contexts that have no Web MIDI (the Ableton WKWebView; Safari/iOS). Same
// MidiHandlers/MidiController contract as midi.ts. The bridge is a dumb raw-byte relay that delivers
// COMPLETE MIDI messages (rtmidi never splits SysEx), so no F0→F7 reassembly is needed here.

import { emit } from '../events/bus'
import type { AppEventMap } from '../events/types'
import {
  currentProgramDump,
  currentProgramDumpRequest,
  decodeCurrentProgramDump,
  isCurrentProgramDump,
} from '../parser/korg-sysex'
import type { MidiController, MidiHandlers } from './midi'

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL || 'ws://127.0.0.1:8766'
const DEVICE = 'minilogue xd (bridge)'
const ACTIVITY_TIMEOUT = 4000
const RECONNECT_MS = 2000
const POLL_MS = 1500
// Hold the full-dump poll while a knob is actively streaming CC — the ~1.2 KB dump round-trip
// would otherwise hitch the live needle stream every 1.5s.
const CC_QUIET_MS = 1000

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

/** Connect to the local bridge and mirror the synth. Returns a controller that keeps retrying if the
    bridge isn't running yet (so launching it later just works); null only when WebSocket is absent. */
export async function connectBridge(
  handlers: MidiHandlers,
): Promise<MidiController | null> {
  if (typeof WebSocket === 'undefined') {
    emitStatus('unsupported')
    return null
  }

  let ws: WebSocket | undefined
  let pendingMode: 'full' | 'program' | 'poll' | 'idle' = 'idle'
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let lastSeen = 0
  let lastCcAt = 0
  let lastState: MidiStatus['state'] | '' = ''
  let disposed = false

  const isOpen = (): boolean => !!ws && ws.readyState === WebSocket.OPEN

  const send = (bytes: Uint8Array): void => {
    if (isOpen()) ws?.send(bytes as BufferSource)
  }
  const sendRequest = (): void => {
    for (let ch = 0; ch < 16; ch++) send(currentProgramDumpRequest(ch))
  }
  const sendProgram = (prog: Uint8Array): boolean => {
    if (!isOpen()) return false
    for (let ch = 0; ch < 16; ch++) send(currentProgramDump(prog, ch))
    return true
  }
  const refresh = (seedLive = true): void => {
    pendingMode = seedLive ? 'full' : 'program'
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(sendRequest, 120)
  }

  function handleSysex(msg: Uint8Array): void {
    if (!isCurrentProgramDump(msg)) return
    const mode = pendingMode
    pendingMode = 'idle'
    if (mode === 'idle') return
    try {
      const prog = decodeCurrentProgramDump(msg)
      if (mode === 'poll') handlers.onPoll(prog)
      else handlers.onDump(prog, mode === 'full')
    } catch (err) {
      console.warn(
        `[bridge-midi] ignoring bad program dump: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // One WebSocket frame = one complete MIDI message (the bridge relays rtmidi messages verbatim).
  function onMidi(data: Uint8Array): void {
    if (data.length === 0) return
    lastSeen = Date.now() // any byte (incl. Active Sensing) is the synth's heartbeat
    if (lastState !== 'connected') evaluateStatus()
    const status = data[0]
    if (status === 0xf0) {
      handleSysex(data)
    } else if (status >= 0xf8) {
      // System real-time (Active Sensing) — liveness only.
    } else if ((status & 0xf0) === 0xb0 && data.length >= 3) {
      lastCcAt = Date.now()
      handlers.onControlChange(data[1], data[2])
    } else if ((status & 0xf0) === 0xc0) {
      refresh(false) // program change → re-pull values, leave live needles
    }
  }

  function evaluateStatus(): void {
    const live = isOpen() && Date.now() - lastSeen < ACTIVITY_TIMEOUT
    const state: MidiStatus['state'] = live ? 'connected' : 'no-device'
    if (state === lastState) return
    lastState = state
    if (live) emitStatus(state, { device: DEVICE })
    else {
      emitStatus(state, {
        detail: isOpen()
          ? 'minilogue xd not detected'
          : 'MIDI bridge not running',
      })
    }
  }

  function connect(): void {
    emitStatus('requesting')
    try {
      ws = new WebSocket(BRIDGE_URL)
    } catch {
      scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      refresh()
      evaluateStatus()
    }
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) onMidi(new Uint8Array(e.data))
    }
    ws.onclose = () => {
      evaluateStatus()
      scheduleReconnect()
    }
    ws.onerror = () => {} // onclose follows and handles reconnect
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (!disposed) connect()
    }, RECONNECT_MS)
  }

  connect()

  const statusInterval = setInterval(evaluateStatus, 1000)
  const pollInterval = setInterval(() => {
    // Skip while a knob is streaming CC (don't hitch the live needles) and while a
    // connect/refresh/program-change dump is still in flight (don't steal its pendingMode and
    // swallow the render as a silent poll). A stale 'poll' can be re-fired, so it self-heals.
    if (!isOpen()) return
    if (pendingMode === 'full' || pendingMode === 'program') return
    if (Date.now() - lastCcAt < CC_QUIET_MS) return
    pendingMode = 'poll'
    sendRequest()
  }, POLL_MS)

  function dispose(): void {
    disposed = true
    clearInterval(statusInterval)
    clearInterval(pollInterval)
    if (refreshTimer) clearTimeout(refreshTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
  }

  return { refresh: () => refresh(true), sendProgram, dispose }
}
