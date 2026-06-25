import { adoptStyles, clamp01, define, knobAngle, onParam } from './util'

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
    border-radius: 1px;
    transform-origin: 50% 100%;
    transition: transform var(--wa-transition-normal, 0.15s) cubic-bezier(0.4, 0, 0.2, 1);
  }
  /* Program (loaded patch / current program) needle. */
  .indicator.program {
    height: 44%;
    background: var(--xd-knob-teal, #2dd4bf);
    transform: translateX(-50%) rotate(var(--knob-angle, -135deg));
  }
  /* Live needle: the connected synth's actual knob position. Same length as the
     program needle so a given value points to the same spot; thinner and drawn
     on top so both stay legible when they coincide. Hidden until a live value. */
  .indicator.live {
    height: 44%;
    width: 1.5px;
    background: var(--xd-knob-live, #f6a821);
    transform: translateX(-50%) rotate(var(--knob-angle-live, -135deg));
  }
  :host(:not([live])) .indicator.live { display: none; }

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
  #offs: Array<() => void> = []
  #value = 0
  #program = ''
  #live: string | undefined

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    if (!this.hasAttribute('decorative')) {
      this.#offs.push(
        onParam('param:change', this, (v, d) => this.#applyProgram(v, d)),
        onParam('param:live', this, (v, d) => this.#applyLive(v, d)),
      )
    }
  }

  disconnectedCallback(): void {
    for (const off of this.#offs) off()
    this.#offs = []
  }

  #build(): void {
    adoptStyles(this.#shadow, styles)
    const label = this.getAttribute('label') ?? ''
    this.#shadow.innerHTML = `<div class="knob" part="knob"><span class="indicator program" part="indicator"></span><span class="indicator live" part="indicator-live"></span></div><span class="label" part="label">${label}</span>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#applyProgram(initial === null ? 0 : Number(initial))
  }

  #applyProgram(value: number, display?: string): void {
    this.#value = clamp01(value)
    this.style.setProperty('--knob-angle', `${knobAngle(this.#value)}deg`)
    this.#program = display ?? `${Math.round(this.#value * 100)}%`
    this.#updateAria()
  }

  #applyLive(value: number, display?: string): void {
    const v = clamp01(value)
    this.setAttribute('live', '')
    this.style.setProperty('--knob-angle-live', `${knobAngle(v)}deg`)
    this.#live = display ?? `${Math.round(v * 100)}%`
    this.#updateAria()
  }

  #updateAria(): void {
    const label = this.getAttribute('label') ?? ''
    const readout =
      this.#live !== undefined && this.#live !== this.#program
        ? `${this.#program} (synth ${this.#live})`
        : this.#program
    this.setAttribute('aria-label', label ? `${label}: ${readout}` : readout)
  }
}

define('xd-knob', XdKnob)
