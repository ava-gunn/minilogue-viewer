import { emit, on } from '../events/bus'
import { PARAMS } from './params'

// Kept out of app.ts so the live page doesn't pull in the file-loading / audio-inference bundle.
export function initShared(): void {
  initFanout()
  initStatus()
  initTooltips()
  initColors()
}

function initColors(): void {
  const root = document.documentElement
  const wire = (id: string, prop: string): void => {
    const input = document.getElementById(id)
    if (!(input instanceof HTMLInputElement)) return
    root.style.setProperty(prop, input.value)
    input.addEventListener('input', () =>
      root.style.setProperty(prop, input.value),
    )
  }
  wire('color-prog', '--xd-knob-teal')
  wire('color-live', '--xd-knob-live')

  // The Program/Synth legend (two needle colours) only applies while a synth is connected.
  const legend = document.querySelector('.midi-legend')
  on('midi:status', ({ state }) => {
    legend?.toggleAttribute('hidden', state !== 'connected')
  })
}

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

// WA tooltips are for=-anchored so they stay out of the panel's flow and don't affect layout.
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
