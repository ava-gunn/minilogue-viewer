import { emit, on } from '../events/bus'
import { parseArchive } from '../parser'
import type { MinilogueXDPatch } from '../types/synth'

// No audio/inference dependency: shared with the Ableton embed (embed.ts), which must stay ONNX-free.

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

export function initLibrary(): void {
  on('file:parsed-lib', ({ patches }) => {
    const panel = document.getElementById('library-panel')
    const list = document.getElementById('program-list')
    if (!panel || !list) return

    const options = (): HTMLElement[] =>
      Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'))

    const select = (
      li: HTMLElement,
      patch: MinilogueXDPatch,
      index: number,
    ): void => {
      // Roving tabindex: the selected option is the single tab stop for the listbox.
      for (const el of options()) {
        el.setAttribute('aria-selected', el === li ? 'true' : 'false')
        el.tabIndex = el === li ? 0 : -1
      }
      emit('patch:load', { patch, index, total: patches.length })
    }

    const focusAt = (i: number): void => {
      const opts = options()
      opts[((i % opts.length) + opts.length) % opts.length]?.focus()
    }

    list.replaceChildren(
      ...patches.map((patch, index) => {
        const opt = document.createElement('div')
        opt.setAttribute('role', 'option')
        opt.tabIndex = index === 0 ? 0 : -1
        opt.setAttribute('aria-selected', index === 0 ? 'true' : 'false')
        opt.textContent = `${String(index + 1).padStart(3, '0')}  ${patch.name || 'INIT'}`
        opt.addEventListener('click', () => select(opt, patch, index))
        opt.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            select(opt, patch, index)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            focusAt(index + 1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            focusAt(index - 1)
          } else if (e.key === 'Home') {
            e.preventDefault()
            focusAt(0)
          } else if (e.key === 'End') {
            e.preventDefault()
            focusAt(patches.length - 1)
          }
        })
        return opt
      }),
    )
    panel.removeAttribute('hidden')
    panel.setAttribute('open', '')
  })
}
