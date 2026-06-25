import { adoptStyles, define, onParam, splitLabels } from './util'

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

  /* Two levers: program (loaded patch) and live (synth's actual position). */
  .lever {
    position: absolute;
    top: 2px;
    height: calc((100% - 4px) / var(--positions, 2));
    border-radius: 0.3rem;
    box-shadow: 0 1px 2px #000c, inset 0 1px 0 #ffffff33;
    transition: transform var(--wa-transition-normal, 0.15s) ease;
  }
  .lever.program {
    left: 2px;
    width: calc((100% - 6px) / 2);
    background: var(--xd-knob-teal, #2dd4bf);
    transform: translateY(calc(var(--active, 0) * 100%));
  }
  .lever.live {
    right: 2px;
    width: calc((100% - 6px) / 2);
    background: var(--xd-knob-live, #f6a821);
    transform: translateY(calc(var(--active-live, 0) * 100%));
  }
  /* Until the synth reports a value, the program lever fills the track. */
  :host(:not([live])) .lever.live { display: none; }
  :host(:not([live])) .lever.program { width: calc(100% - 4px); }

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
  #offs: Array<() => void> = []
  #positions: string[] = []
  #program = 0
  #live = -1

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    if (!this.hasAttribute('decorative')) {
      this.#offs.push(
        onParam('param:change', this, (v) => this.#applyProgram(v)),
        onParam('param:live', this, (v) => this.#applyLive(v)),
      )
    }
  }

  disconnectedCallback(): void {
    for (const off of this.#offs) off()
    this.#offs = []
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
    this.#shadow.innerHTML = `<div class="switch"><div class="track" part="track"><span class="lever program" part="lever"></span><span class="lever live" part="lever-live"></span></div><div class="ticks" part="ticks">${ticks}</div></div><span class="label" part="label">${label}</span>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#applyProgram(initial === null ? 0 : Number(initial))
  }

  #clamp(index: number): number {
    const count = Math.max(this.#positions.length, 1)
    return Math.min(Math.max(Math.round(index), 0), count - 1)
  }

  /** Reverse-aware track slot for a position index. */
  #slot(active: number): number {
    const count = Math.max(this.#positions.length, 1)
    return this.hasAttribute('reverse') ? count - 1 - active : active
  }

  #applyProgram(index: number): void {
    this.#program = this.#clamp(index)
    this.style.setProperty('--active', String(this.#slot(this.#program)))
    for (const el of this.#shadow.querySelectorAll('.ticks span')) {
      el.classList.toggle(
        'on',
        Number(el.getAttribute('data-index')) === this.#program,
      )
    }
    this.#updateAria()
  }

  #applyLive(index: number): void {
    this.#live = this.#clamp(index)
    this.setAttribute('live', '')
    this.style.setProperty('--active-live', String(this.#slot(this.#live)))
    this.#updateAria()
  }

  #updateAria(): void {
    const label = this.getAttribute('label') ?? ''
    const prog = this.#positions[this.#program] ?? String(this.#program)
    const live = this.#positions[this.#live] ?? String(this.#live)
    const readout =
      this.#live >= 0 && this.#live !== this.#program
        ? `${prog} (synth ${live})`
        : prog
    this.setAttribute('aria-label', label ? `${label}: ${readout}` : readout)
  }
}

define('xd-switch', XdSwitch)
