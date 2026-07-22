import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clear, on } from '../events/bus'
import type { MidiHandlers } from './midi'
import { createSynthLink } from './synth-link'

// Capture the handlers createSynthLink wires into the transport, and give it a no-op controller so
// we can drive onDump/onPoll directly (no real Web MIDI / bridge in the test env).
let captured: MidiHandlers | undefined
const controller = {
  refresh: vi.fn(),
  sendProgram: vi.fn(() => true),
  dispose: vi.fn(),
}

vi.mock('./midi', () => ({
  connectMidi: vi.fn(async (h: MidiHandlers) => {
    captured = h
    return controller
  }),
}))
vi.mock('./bridge-midi', () => ({ connectBridge: vi.fn(async () => null) }))

const progWithName = (name: string): Uint8Array => {
  const p = new Uint8Array(1024)
  p.set([0x50, 0x52, 0x4f, 0x47]) // "PROG" magic
  for (let i = 0; i < name.length && i < 12; i++) p[4 + i] = name.charCodeAt(i)
  return p
}

beforeEach(() => {
  clear()
  captured = undefined
})
afterEach(() => {
  clear()
})

it('poll renders a different program but not an in-place edit of the same one', async () => {
  const loads: string[] = []
  const off = on('patch:load', (e) => loads.push(e.patch.name))
  createSynthLink()
  await vi.waitFor(() => expect(captured).toBeTruthy())
  const h = captured as MidiHandlers

  const bass = progWithName('BASS 01')
  h.onDump(bass, true) // initial dump renders + captures the template

  const editedBass = bass.slice()
  editedBass[600] ^= 0xff // a knob edit: same program name, different bytes
  h.onPoll(editedBass) // must NOT re-render (would clobber the live needles)

  const lead = progWithName('LEAD 09')
  h.onPoll(lead) // a genuinely different program (missed/raced Program Change) -> render

  expect(loads).toEqual(['BASS 01', 'LEAD 09'])
  off()
})
