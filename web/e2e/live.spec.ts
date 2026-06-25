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

const knobProp = (page: Page, key: string, prop: string) =>
  page
    .locator(`xd-knob[data-param-key="${key}"]`)
    .first()
    .evaluate((el, p) => el.style.getPropertyValue(p), prop)

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
          {
            name: 'minilogue xd SOUND',
            // A real synth answers once (on its global channel); Web MIDI may
            // split that long dump across events, so deliver it in fragments to
            // exercise SysEx reassembly.
            send: (d: number[]) => {
              if (d[2] !== 0x30) return
              for (let i = 0; i < bytes.length; i += 256) {
                listener?.(evt(bytes.slice(i, i + 256)))
              }
            },
          },
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

test('detects a synth, pulls its program, and mirrors a live CC', async ({
  page,
}) => {
  await fakeMidi(page, DUMP)
  await page.goto('/')

  await expect.poll(() => statusState(page)).toBe('connected')

  // The auto-requested dump renders the program onto the panel (program layer).
  await expect.poll(() => oledName(page)).toBe('Replicant xd')
  await expect(
    page.locator('xd-wave-selector[data-section="vco1"]'),
  ).toHaveAttribute('aria-label', 'WAVE: SAW')

  // A live Control Change moves the LIVE needle only; the program needle stays.
  const liveBefore = await knobProp(page, 'cutoff', '--knob-angle-live')
  const progBefore = await knobProp(page, 'cutoff', '--knob-angle')
  await page.evaluate(() =>
    (window as unknown as { __emitMidi: (b: number[]) => void }).__emitMidi([
      0xb0, 43, 0,
    ]),
  )
  await expect
    .poll(() => knobProp(page, 'cutoff', '--knob-angle-live'))
    .not.toBe(liveBefore)
  expect(await knobProp(page, 'cutoff', '--knob-angle')).toBe(progBefore)

  // A toggle mirrors program vs synth too: flip VCO1 wave on the synth (→ TRI).
  await page.evaluate(() =>
    (window as unknown as { __emitMidi: (b: number[]) => void }).__emitMidi([
      0xb0, 50, 64,
    ]),
  )
  const wave = page.locator('xd-wave-selector[data-section="vco1"]')
  await expect(wave).toHaveAttribute('live', '')
  await expect
    .poll(() =>
      wave.evaluate((el) => el.style.getPropertyValue('--active-live')),
    )
    .toBe('1') // synth → TRI (slot 1)
  expect(
    await wave.evaluate((el) => el.style.getPropertyValue('--active')),
  ).toBe('0') // program stays SAW (slot 0)

  // The legend swatch recolors the program indicator.
  await page.locator('#color-prog').evaluate((el) => {
    ;(el as HTMLInputElement).value = '#ff0000'
    el.dispatchEvent(new Event('input'))
  })
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--xd-knob-teal'),
    ),
  ).toBe('#ff0000')

  // Clicking an effect in the FX status selects it (so TIME/DEPTH follow it).
  const fxActive = (fx: string) =>
    page
      .locator('xd-fx-status')
      .evaluate(
        (el, f) =>
          el.shadowRoot
            ?.querySelector(`.fx[data-section="${f}"]`)
            ?.classList.contains('active') ?? false,
        fx,
      )
  await page
    .locator('xd-fx-status')
    .evaluate((el) =>
      (
        el.shadowRoot?.querySelector('.fx[data-section="delay"]') as HTMLElement
      )?.click(),
    )
  await expect.poll(() => fxActive('delay')).toBe(true)
})
