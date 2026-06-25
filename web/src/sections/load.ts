import { emit, on } from '../events/bus'
import { parseArchive } from '../parser'
import type { MinilogueXDPatch } from '../types/synth'

// Patch-file loading + library drawer, with no audio/inference dependency — shared by the
// full viewer (app.ts) and the Ableton embed (embed.ts), which must stay ONNX-free.

/** A dropped/browsed file → parsed patches → events. */
export function initLoad(): void {
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
export function initLibrary(): void {
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
