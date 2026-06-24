import { on } from '../events/bus'
import { adoptStyles, clamp01, define, knobAngle } from './util'

const styles = `
  :host {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: var(--wa-space-2xs, 0.25rem);
    font-family: var(--xd-font);
  }
  :host([decorative]) { opacity: var(--xd-decorative-opacity, 0.45); }

  .knob {
    position: relative;
    width: var(--xd-knob-size, 2.5rem);
    height: var(--xd-knob-size, 2.5rem);
    border-radius: 50%;
    background: radial-gradient(circle at 35% 28%, var(--xd-knob-cap, #3a3a42), var(--xd-knob-body, #2a2a30) 70%);
    box-shadow: var(--wa-shadow-m, 0 2px 6px #000a), inset 0 0 0 1px #0006;
  }

  .indicator {
    position: absolute;
    left: 50%;
    bottom: 50%;
    width: 2px;
    height: 44%;
    background: var(--xd-knob-teal, #2dd4bf);
    border-radius: 1px;
    transform-origin: 50% 100%;
    transform: translateX(-50%) rotate(var(--knob-angle, -135deg));
    transition: transform var(--wa-transition-normal, 0.15s) cubic-bezier(0.4, 0, 0.2, 1);
  }

  .label {
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }

  @media (prefers-reduced-motion: reduce) {
    .indicator { transition: none; }
  }
`

class XdKnob extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #off: (() => void) | undefined
  #value = 0

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    if (!this.hasAttribute('decorative')) {
      this.#off = on('param:change', ({ section, key, value, display }) => {
        if (section === this.dataset.section && key === this.dataset.paramKey) {
          this.#apply(value, display)
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
    const label = this.getAttribute('label') ?? ''
    this.#shadow.innerHTML = `<div class="knob" part="knob"><span class="indicator" part="indicator"></span></div><span class="label" part="label">${label}</span>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#apply(initial === null ? 0 : Number(initial))
  }

  #apply(value: number, display?: string): void {
    this.#value = clamp01(value)
    this.style.setProperty('--knob-angle', `${knobAngle(this.#value)}deg`)
    const label = this.getAttribute('label') ?? ''
    const readout = display ?? `${Math.round(this.#value * 100)}%`
    this.setAttribute('aria-label', label ? `${label}: ${readout}` : readout)
  }
}

define('xd-knob', XdKnob)
