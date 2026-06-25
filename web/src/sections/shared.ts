import { emit, on } from '../events/bus'
import { PARAMS } from './params'

/** Panel-generic wiring reused by both pages (file viewer + live MIDI): patch
    fanout, knob tooltips, and the transient error badge. Kept out of app.ts so
    the live page doesn't pull in the file-loading / audio-inference bundle. */
export function initShared(): void {
  initFanout()
  initStatus()
  initTooltips()
  initColors()
}

/** Let the footer legend swatches (Program / Synth) recolour the indicators live. */
function initColors(): void {
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

  interface Tip {
    el: HTMLElement
    prog?: string
    live?: string
  }
  const tips = new Map<string, Tip>()
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
    tips.set(`${knob.dataset.section}:${knob.dataset.paramKey}`, { el: tip })
  }

  const render = (t: Tip): void => {
    const prog = t.prog ?? '—'
    t.el.textContent =
      t.live !== undefined && t.live !== t.prog ? `${prog} → ${t.live}` : prog
  }

  // Program value (loaded patch) and the live synth value share each tooltip.
  on('param:change', ({ section, key, display }) => {
    if (display === undefined) return
    const t = tips.get(`${section}:${key}`)
    if (t) {
      t.prog = display
      render(t)
    }
  })
  on('param:live', ({ section, key, display }) => {
    if (display === undefined) return
    const t = tips.get(`${section}:${key}`)
    if (t) {
      t.live = display
      render(t)
    }
  })
}
