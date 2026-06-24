import { on } from '../events/bus'
import { adoptStyles, define, splitLabels } from './util'

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
    height: calc((100% - 4px) / var(--positions, 2));
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
    font-size: 0.45rem;
    letter-spacing: 0.04em;
    color: var(--xd-label-color, #8a8a92);
  }
  .ticks span { line-height: 1; }
  .ticks span.on { color: var(--xd-knob-teal, #2dd4bf); }

  .label {
    font-size: 0.55rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }

  /* Bare toggle — no position labels (e.g. DRIVE / KEY TRACK on the device). */
  :host([hide-ticks]) .ticks { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .lever { transition: none; }
  }
`

class XdSwitch extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #off: (() => void) | undefined
  #positions: string[] = []
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
    this.#positions = splitLabels(this.getAttribute('positions'))
    const count = Math.max(this.#positions.length, 2)
    this.style.setProperty('--positions', String(count))
    const label = this.getAttribute('label') ?? ''
    // `reverse` puts the first position at the bottom (e.g. 0 low, 100 high).
    const order = this.#positions.map((p, i) => ({ p, i }))
    if (this.hasAttribute('reverse')) order.reverse()
    const ticks = order
      .map(({ p, i }) => `<span data-index="${i}">${p}</span>`)
      .join('')
    this.#shadow.innerHTML = `<div class="switch"><div class="track" part="track"><span class="lever" part="lever"></span></div><div class="ticks" part="ticks">${ticks}</div></div><span class="label" part="label">${label}</span>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#apply(initial === null ? 0 : Number(initial))
  }

  #apply(index: number): void {
    const count = Math.max(this.#positions.length, 1)
    this.#active = Math.min(Math.max(Math.round(index), 0), count - 1)
    const slot = this.hasAttribute('reverse')
      ? count - 1 - this.#active
      : this.#active
    this.style.setProperty('--active', String(slot))
    for (const el of this.#shadow.querySelectorAll('.ticks span')) {
      el.classList.toggle(
        'on',
        Number(el.getAttribute('data-index')) === this.#active,
      )
    }
    const label = this.getAttribute('label') ?? ''
    const pos = this.#positions[this.#active] ?? String(this.#active)
    this.setAttribute('aria-label', label ? `${label}: ${pos}` : pos)
  }
}

define('xd-switch', XdSwitch)
