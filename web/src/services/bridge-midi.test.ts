import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clear } from '../events/bus'
import { currentProgramDump } from '../parser/korg-sysex'
import { connectBridge } from './bridge-midi'

type Handler = (() => void) | null

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: MockWebSocket | undefined
  readyState = MockWebSocket.CONNECTING
  binaryType = 'blob'
  onopen: Handler = null
  onclose: Handler = null
  onerror: Handler = null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null
  sent: Uint8Array[] = []
  constructor(public url: string) {
    MockWebSocket.last = this
  }
  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data))
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }
  // test helpers
  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
  fireMessage(bytes: Uint8Array): void {
    // Copy to an exactly-sized buffer, as a real ws binary frame would be.
    this.onmessage?.({ data: bytes.slice().buffer })
  }
}

beforeEach(() => {
  clear()
  vi.useFakeTimers()
  MockWebSocket.last = undefined
  ;(globalThis as { WebSocket?: unknown }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket
})
afterEach(() => {
  vi.useRealTimers()
})

const lastWs = (): MockWebSocket => {
  const ws = MockWebSocket.last
  if (!ws) throw new Error('no WebSocket created')
  return ws
}

// A minimal valid prog_bin: decodeCurrentProgramDump requires the leading "PROG" magic.
const progBin = (): Uint8Array => {
  const p = new Uint8Array(1024)
  p.set([0x50, 0x52, 0x4f, 0x47])
  return p
}

it('routes a bridged program dump to onDump (seedLive on connect)', async () => {
  const onDump = vi.fn()
  const ctrl = await connectBridge({
    onDump,
    onPoll: vi.fn(),
    onControlChange: vi.fn(),
  })
  expect(ctrl).not.toBeNull()
  const ws = lastWs()
  ws.fireOpen() // onopen -> refresh() arms pendingMode='full'
  ws.fireMessage(currentProgramDump(progBin(), 0))
  expect(onDump).toHaveBeenCalledTimes(1)
  expect(onDump.mock.calls[0]?.[1]).toBe(true)
  ctrl?.dispose()
})

it('routes Control Change to onControlChange', async () => {
  const onCC = vi.fn()
  const ctrl = await connectBridge({
    onDump: vi.fn(),
    onPoll: vi.fn(),
    onControlChange: onCC,
  })
  const ws = lastWs()
  ws.fireOpen()
  ws.fireMessage(new Uint8Array([0xb0, 43, 100]))
  expect(onCC).toHaveBeenCalledWith(43, 100)
  ctrl?.dispose()
})

it('sendProgram broadcasts 16 channels when open', async () => {
  const ctrl = await connectBridge({
    onDump: vi.fn(),
    onPoll: vi.fn(),
    onControlChange: vi.fn(),
  })
  const ws = lastWs()
  ws.fireOpen()
  ws.sent.length = 0
  expect(ctrl?.sendProgram(new Uint8Array(1024))).toBe(true)
  expect(ws.sent).toHaveLength(16)
  ctrl?.dispose()
})

it('still returns a controller when the bridge is down (will retry)', async () => {
  const ctrl = await connectBridge({
    onDump: vi.fn(),
    onPoll: vi.fn(),
    onControlChange: vi.fn(),
  })
  expect(ctrl).not.toBeNull()
  expect(ctrl?.sendProgram(new Uint8Array(1024))).toBe(false) // not open yet
  ctrl?.dispose()
})
