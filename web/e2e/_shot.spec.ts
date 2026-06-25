import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, test } from '@playwright/test'
import { korgEncode8to7 } from '../src/parser/korg-sysex'
import { extractProgramBins } from '../src/parser/unzip'

const SHOT = '/private/tmp/claude-501/-Users-ava-Developer-minilogue-viewer/84e1f408-491b-4778-8ae9-c4e8670f13dd/scratchpad'
const progBin = extractProgramBins(
  new Uint8Array(
    readFileSync(join(process.cwd(), 'replicant-example.mnlgxdprog')),
  ),
)[0]
const DUMP = [0xf0, 0x42, 0x30, 0x00, 0x01, 0x51, 0x40, ...korgEncode8to7(progBin), 0xf7]

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
      outputs: new Map([['o', { name: 'minilogue xd SOUND', send: () => listener?.(evt(bytes)) }]]),
      onstatechange: null,
    }
    ;(window as unknown as { __emitMidi: (b: number[]) => void }).__emitMidi = (b) =>
      listener?.(evt(b))
    ;(navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess =
      async () => access
  }, dump)
}

test('shot', async ({ page }) => {
  await fakeMidi(page, DUMP)
  await page.goto('/')
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const e = (window as unknown as { __emitMidi: (b: number[]) => void }).__emitMidi
    e([0xb0, 43, 20]) // cutoff live low (knob diverges from program)
    e([0xb0, 50, 64]) // vco1 wave → TRI (program SAW)
    e([0xb0, 48, 127]) // vco1 octave → 2' (diverge)
    e([0xb0, 52, 32]) // voice mode → UNISON
    e([0xb0, 94, 0]) // reverb off
  })
  await page.waitForTimeout(300)
  await page.locator('.midi-bar').screenshot({ path: `${SHOT}/shot-bar.png` })
  await page.locator('.grp-vco').screenshot({ path: `${SHOT}/shot-vco.png` })
  await page.locator('.grp-perf').screenshot({ path: `${SHOT}/shot-perf.png` })
  await page.locator('.grp-fx').screenshot({ path: `${SHOT}/shot-fx.png` })
})
