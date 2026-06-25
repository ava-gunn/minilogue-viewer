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

  .leds { display: flex; flex-direction: column; gap: 0.2rem; }
  :host([orientation="horizontal"]) .leds { flex-direction: row; }

  .row { display: flex; align-items: center; gap: 0.35rem; }

  .led {
    inline-size: 0.45rem;
    block-size: 0.45rem;
    border-radius: 50%;
    background: var(--xd-led-off, #14302c);
    box-shadow: inset 0 0 0 1px #0008;
    flex: none;
  }
  /* program (loaded patch) → teal fill; live (synth) → amber ring. */
  .row.prog .led {
    background: var(--xd-knob-teal, #2dd4bf);
    box-shadow: 0 0 4px var(--xd-knob-teal, #2dd4bf), inset 0 0 0 1px #0008;
  }
  .row.live .led {
    outline: 1.5px solid var(--xd-knob-live, #f6a821);
    outline-offset: 1px;
  }

  .led-label {
    font-size: 0.5rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }
  .row.prog .led-label { color: var(--xd-label-bright, #c4c4cc); }

  .label {
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }
`

class XdLedGroup extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #offs: Array<() => void> = []
  #labels: string[] = []
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
    this.#labels = splitLabels(this.getAttribute('labels'))
    const groupLabel = this.getAttribute('label')
    const rows = this.#labels
      .map(
        (l) =>
          `<div class="row"><span class="led" part="led"></span><span class="led-label">${l}</span></div>`,
      )
      .join('')
    const header = groupLabel
      ? `<span class="label" part="label">${groupLabel}</span>`
      : ''
    this.#shadow.innerHTML = `${header}<div class="leds" part="leds">${rows}</div>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#applyProgram(initial === null ? 0 : Number(initial))
  }

  #clamp(index: number): number {
    const count = Math.max(this.#labels.length, 1)
    return Math.min(Math.max(Math.round(index), 0), count - 1)
  }

  #applyProgram(index: number): void {
    this.#program = this.#clamp(index)
    const rows = this.#shadow.querySelectorAll('.row')
    rows.forEach((el, i) => {
      el.classList.toggle('prog', i === this.#program)
    })
    this.#updateAria()
  }

  #applyLive(index: number): void {
    this.#live = this.#clamp(index)
    this.setAttribute('live', '')
    const rows = this.#shadow.querySelectorAll('.row')
    rows.forEach((el, i) => {
      el.classList.toggle('live', i === this.#live)
    })
    this.#updateAria()
  }

  #updateAria(): void {
    const group = this.getAttribute('label')
    const prog = this.#labels[this.#program] ?? String(this.#program)
    const live = this.#labels[this.#live] ?? String(this.#live)
    const readout =
      this.#live >= 0 && this.#live !== this.#program
        ? `${prog} (hardware ${live})`
        : prog
    this.setAttribute('aria-label', group ? `${group}: ${readout}` : readout)
  }
}

define('xd-led-group', XdLedGroup)
