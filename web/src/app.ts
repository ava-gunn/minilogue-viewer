import { emit, on } from './events/bus'
import { matchAudioFile } from './inference'
import { parseArchive } from './parser'
import { initShared } from './sections/shared'
import type { MinilogueXDPatch } from './types/synth'

/** Wire the file-viewer page: file/audio loading → parse → panel updates. */
export function initApp(): void {
  initLoad()
  initAudio()
  initLibrary()
  initShared()
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
