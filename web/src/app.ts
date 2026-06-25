import { emit, on } from './events/bus'
import { matchAudioFile } from './inference'
import { parseArchive } from './parser'
import { initEffects } from './sections/effects'
import { initShared } from './sections/shared'
import { createLivePatch } from './services/live-patch'
import { connectMidi } from './services/midi'
import type { MinilogueXDPatch } from './types/synth'

/** Wire the app: file/audio loading + live MIDI → parse → panel updates. */
export function initApp(): void {
  initLoad()
  initAudio()
  initLibrary()
  initShared()
  initEffects()
  initLive()
  initColorControls()
}

/** Let the legend swatches recolor the program / synth indicators live. */
function initColorControls(): void {
  const root = document.documentElement
  const wire = (id: string, prop: string): void => {
    const input = document.getElementById(id)
    if (!(input instanceof HTMLInputElement)) return
    // Sync the rendered colour to the swatch's initial value, then track edits.
    root.style.setProperty(prop, input.value)
    input.addEventListener('input', () =>
      root.style.setProperty(prop, input.value),
    )
  }
  wire('color-prog', '--xd-knob-teal')
  wire('color-live', '--xd-knob-live')
}

/** A dropped/browsed audio file → sound-matched patch → events. */
function initAudio(): void {
  on('audio:dropped', async ({ file }) => {
    try {
      const patch = await matchAudioFile(file)
      emit('patch:load', { patch, index: 0, total: 1 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('file:error', {
        message: `Could not match ${file.name}: ${message}`,
      })
    }
  })
}

/** A dropped/browsed file → parsed patches → events. */
function initLoad(): void {
  on('file:dropped', async ({ file }) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const patches = parseArchive(bytes)
      if (patches.length === 0) {
        emit('file:error', { message: `No programs found in ${file.name}` })
        return
      }
      if (patches.length > 1) {
        emit('file:parsed-lib', { name: file.name, patches })
      }
      emit('patch:load', { patch: patches[0], index: 0, total: patches.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('file:error', { message: `Could not read ${file.name}: ${message}` })
    }
  })
}

/** Program library drawer for .mnlgxdlib files. */
function initLibrary(): void {
  on('file:parsed-lib', ({ patches }) => {
    const panel = document.getElementById('library-panel')
    const list = document.getElementById('program-list')
    if (!panel || !list) return

    const select = (
      li: HTMLElement,
      patch: MinilogueXDPatch,
      index: number,
    ): void => {
      for (const el of list.querySelectorAll('[aria-selected]')) {
        el.removeAttribute('aria-selected')
      }
      li.setAttribute('aria-selected', 'true')
      emit('patch:load', { patch, index, total: patches.length })
    }

    list.replaceChildren(
      ...patches.map((patch, index) => {
        const li = document.createElement('li')
        li.setAttribute('role', 'option')
        li.textContent = `${String(index + 1).padStart(3, '0')}  ${patch.name || 'INIT'}`
        if (index === 0) li.setAttribute('aria-selected', 'true')
        li.addEventListener('click', () => select(li, patch, index))
        return li
      }),
    )
    panel.removeAttribute('hidden')
    panel.setAttribute('open', '')
  })
}

const MIDI_MESSAGES: Record<string, string> = {
  unsupported:
    'Web MIDI isn’t supported here — open this page in Chrome or Edge.',
  requesting: 'Connecting to MIDI…',
  denied: 'MIDI access was denied. Reload the page and allow it.',
  'no-device':
    'No minilogue xd detected — connect it over USB to mirror it live.',
  connected: 'minilogue xd connected.',
  error: 'MIDI error.',
}

/** Detect a connected minilogue xd and mirror its live control positions. */
function initLive(): void {
  initMidiStatus()
  const live = createLivePatch()
  void (async () => {
    const midi = await connectMidi({
      onDump: live.loadDump,
      onPoll: live.pollDump,
      onControlChange: live.controlChange,
    })
    const btn = document.getElementById('midi-refresh')
    if (!btn) return
    if (midi) btn.addEventListener('click', () => midi.refresh())
    else btn.setAttribute('hidden', '')
  })()
}

function initMidiStatus(): void {
  const status = document.getElementById('midi-status')
  const text = status?.querySelector('.midi-text')
  const btn = document.getElementById('midi-refresh')

  on('midi:status', ({ state, device, detail }) => {
    if (status) status.dataset.state = state
    if (text) {
      let msg = MIDI_MESSAGES[state] ?? state
      if (state === 'connected' && device) msg = `${device} connected`
      else if (state === 'error' && detail) msg = detail
      text.textContent = msg
    }
    btn?.toggleAttribute('hidden', state !== 'connected')
  })
}
