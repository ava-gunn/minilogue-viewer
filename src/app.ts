import { emit, on } from './events/bus'
import { parseArchive } from './parser'
import { PARAMS } from './sections/params'
import type { MinilogueXDPatch } from './types/synth'

/** Wire the whole application: file loading → parse → panel updates. */
export function initApp(): void {
  initLoad()
  initFanout()
  initLibrary()
  initStatus()
  initTooltips()
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

/** On patch load, push every parameter out to its control. */
function initFanout(): void {
  on('patch:load', ({ patch }) => {
    for (const { section, key, value, display } of PARAMS) {
      const v = value(patch)
      const text = display?.(patch)
      emit(
        'param:change',
        text === undefined
          ? { section, key, value: v }
          : { section, key, value: v, display: text },
      )
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

/** Transient error badge in the status bar. */
function initStatus(): void {
  on('file:error', ({ message }) => {
    const bar = document.getElementById('status-bar')
    if (!bar) return
    const badge = document.createElement('wa-badge')
    badge.setAttribute('variant', 'danger')
    badge.textContent = message
    bar.replaceChildren(badge)
    setTimeout(() => {
      if (bar.firstChild === badge) bar.replaceChildren()
    }, 6000)
  })
}

/** Hover/focus value readout on each knob via WA tooltips (for=-anchored, so
    they stay out of the panel's flow and don't affect layout). */
function initTooltips(): void {
  const container = document.createElement('div')
  container.id = 'tooltips'
  document.body.append(container)

  const tips = new Map<string, HTMLElement>()
  let i = 0
  for (const knob of document.querySelectorAll<HTMLElement>(
    'xd-knob[data-section]',
  )) {
    let id = knob.id
    if (!id) {
      id = `knob-${i++}`
      knob.id = id
    }
    const tip = document.createElement('wa-tooltip')
    tip.setAttribute('for', id)
    tip.setAttribute('placement', 'top')
    tip.textContent = '—'
    container.append(tip)
    tips.set(`${knob.dataset.section}:${knob.dataset.paramKey}`, tip)
  }

  on('param:change', ({ section, key, display }) => {
    if (display === undefined) return
    const tip = tips.get(`${section}:${key}`)
    if (tip) tip.textContent = display
  })
}
