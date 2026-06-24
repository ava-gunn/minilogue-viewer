import { on } from '../events/bus'
import { adoptStyles, define } from './util'

// Displayed top → bottom as on the hardware: SAW, TRI, SQR. `value` is the
// program enum (0=SQR, 1=TRI, 2=SAW), so highlight + position by value.
const WAVES = [
  { value: 2, label: 'SAW', path: 'M1 10 L6 2 V10 L12 2 V10 L18 2 V10' },
  { value: 1, label: 'TRI', path: 'M1 10 L6 2 L11 10 L16 2 L21 10' },
  { value: 0, label: 'SQR', path: 'M1 10 H5 V2 H11 V10 H17 V2 H23' },
] as const

// Built to match <xd-switch>: a lever track with the waveform glyphs as ticks.
const styles = `
  :host {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: var(--wa-space-2xs, 0.25rem);
    font-family: var(--xd-font);
  }
  :host([decorative]) { opacity: var(--xd-decorative-opacity, 0.45); }

  .switch { display: flex; align-items: stretch; gap: 0.25rem; }

  .track {
    position: relative;
    width: var(--xd-toggle-w, 0.85rem);
    height: var(--xd-toggle-h, 2rem);
    padding: 2px;
    border-radius: 0.5rem;
    background: #0b0b0e;
    box-shadow: inset 0 0 0 1px #0009;
  }

  .lever {
    position: absolute;
    left: 2px;
    right: 2px;
    top: 2px;
    height: calc((100% - 4px) / 3);
    border-radius: 0.35rem;
    background: linear-gradient(#6c6c74, #2a2a30);
    box-shadow: 0 1px 2px #000c, inset 0 1px 0 #ffffff22;
    transform: translateY(calc(var(--active, 0) * 100%));
    transition: transform var(--wa-transition-normal, 0.15s) ease;
  }

  .ticks {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .wave { display: grid; place-items: center; color: var(--xd-label-color, #8a8a92); }
  .wave svg { display: block; width: var(--xd-wave-w, 1.1rem); height: var(--xd-wave-h, 0.5rem); }
  .wave path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
  .wave.on { color: var(--xd-knob-teal, #2dd4bf); }

  .label {
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }

  @media (prefers-reduced-motion: reduce) {
    .lever { transition: none; }
  }
`

class XdWaveSelector extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #off: (() => void) | undefined
  #active = 0

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    if (!this.hasAttribute('decorative')) {
      this.#off = on('param:change', ({ section, key, value }) => {
        if (section === this.dataset.section && key === this.dataset.paramKey) {
          this.#apply(value)
        }
      })
    }
  }

  disconnectedCallback(): void {
    this.#off?.()
    this.#off = undefined
  }

  #build(): void {
    adoptStyles(this.#shadow, styles)
    const label = this.getAttribute('label') ?? 'WAVE'
    const ticks = WAVES.map(
      (w) =>
        `<span class="wave" data-value="${w.value}"><svg viewBox="0 0 24 12" aria-hidden="true"><path d="${w.path}"/></svg></span>`,
    ).join('')
    this.#shadow.innerHTML = `<div class="switch"><div class="track" part="track"><span class="lever" part="lever"></span></div><div class="ticks" part="ticks">${ticks}</div></div><span class="label" part="label">${label}</span>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#apply(initial === null ? 0 : Number(initial))
  }

  #apply(value: number): void {
    this.#active = Math.min(Math.max(Math.round(value), 0), WAVES.length - 1)
    const slot = WAVES.findIndex((w) => w.value === this.#active)
    this.style.setProperty('--active', String(slot < 0 ? 0 : slot))
    for (const el of this.#shadow.querySelectorAll('.wave')) {
      el.classList.toggle(
        'on',
        Number(el.getAttribute('data-value')) === this.#active,
      )
    }
    const label = this.getAttribute('label') ?? 'WAVE'
    const name = WAVES.find((w) => w.value === this.#active)?.label ?? ''
    this.setAttribute('aria-label', `${label}: ${name}`)
  }
}

define('xd-wave-selector', XdWaveSelector)
