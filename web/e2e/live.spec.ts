import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { korgEncode8to7 } from '../src/parser/korg-sysex'
import { extractProgramBins } from '../src/parser/unzip'

// A real CURRENT PROGRAM DATA DUMP for the fixture program, built in Node.
const progBin = extractProgramBins(
  new Uint8Array(
    readFileSync(join(process.cwd(), 'replicant-example.mnlgxdprog')),
  ),
)[0]
const DUMP = [
  0xf0,
  0x42,
  0x30,
  0x00,
  0x01,
  0x51,
  0x40,
  ...korgEncode8to7(progBin),
  0xf7,
]

const knobAngle = (page: Page, key: string) =>
  page
    .locator(`xd-knob[data-param-key="${key}"]`)
    .first()
    .evaluate((el) => el.style.getPropertyValue('--knob-angle'))

const oledName = (page: Page) =>
  page
    .locator('#oled')
    .evaluate((el) => el.shadowRoot?.querySelector('.name')?.textContent ?? '')

const statusState = (page: Page) =>
  page.locator('#midi-status').evaluate((el) => el.dataset.state ?? '')

// Stub Web MIDI with a fake minilogue xd that answers the dump request and lets
// the test inject arbitrary MIDI messages via window.__emitMidi.
async function fakeMidi(page: Page, dump: number[]): Promise<void> {
  await page.addInitScript((bytes: number[]) => {
    let listener: ((e: { data: Uint8Array }) => void) | null = null
    const evt = (b: number[]) => ({ data: new Uint8Array(b) })
    const input = {
      name: 'minilogue xd SOUND',
      get onmidimessage() {
        return listener
      },
      set onmidimessage(fn: typeof listener) {
        listener = fn
      },
    }
    const access = {
      inputs: new Map([['i', input]]),
      outputs: new Map([
        [
          'o',
          { name: 'minilogue xd SOUND', send: () => listener?.(evt(bytes)) },
        ],
      ]),
      onstatechange: null,
    }
    ;(window as unknown as { __emitMidi: (b: number[]) => void }).__emitMidi = (
      b,
    ) => listener?.(evt(b))
    ;(
      navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }
    ).requestMIDIAccess = async () => access
  }, dump)
}

test('live page connects, pulls the current program, and mirrors a CC', async ({
  page,
}) => {
  await fakeMidi(page, DUMP)
  await page.goto('/live.html')

  await expect.poll(() => statusState(page)).toBe('connected')

  // The auto-requested dump renders the program onto the panel.
  await expect.poll(() => oledName(page)).toBe('Replicant xd')
  await expect(
    page.locator('xd-wave-selector[data-section="vco1"]'),
  ).toHaveAttribute('aria-label', 'WAVE: SAW')

  // A live Control Change moves only the matching knob (cutoff → 0).
  const cutoffBefore = await knobAngle(page, 'cutoff')
  await page.evaluate(() =>
    (window as unknown as { __emitMidi: (b: number[]) => void }).__emitMidi([
      0xb0, 43, 0,
    ]),
  )
  await expect.poll(() => knobAngle(page, 'cutoff')).not.toBe(cutoffBefore)
})
