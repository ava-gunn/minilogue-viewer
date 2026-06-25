import { emit, on } from '../events/bus'
import { adoptStyles, define } from './util'

// The three effect slots, top → bottom (matches the hardware's MOD/REV/DEL).
const EFFECTS = [
  { label: 'MOD', section: 'modFx' },
  { label: 'REV', section: 'reverb' },
  { label: 'DEL', section: 'delay' },
] as const

const styles = `
  :host {
    display: inline-flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 0.15rem;
    font-family: var(--xd-font);
  }

  .fx {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    /* transparent bar reserves space so selecting one doesn't shift layout */
    border-inline-start: 2px solid transparent;
    padding-inline-start: 0.25rem;
  }
  .fx:hover .label { color: var(--xd-label-bright, #c4c4cc); }
  .fx.active { border-inline-start-color: var(--wa-color-text-normal, #e0e0e6); }

  .dot {
    inline-size: 0.45rem;
    block-size: 0.45rem;
    border-radius: 50%;
    background: var(--xd-led-off, #14302c);
    box-shadow: inset 0 0 0 1px #0008;
    flex: none;
  }
  /* program-on → teal fill; live-on (synth) → amber ring. */
  .fx.prog .dot {
    background: var(--xd-knob-teal, #2dd4bf);
    box-shadow: 0 0 4px var(--xd-knob-teal, #2dd4bf), inset 0 0 0 1px #0008;
  }
  .fx.live .dot {
    outline: 1.5px solid var(--xd-knob-live, #f6a821);
    outline-offset: 1px;
  }

  .label {
    font-size: 0.45rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }
  .fx.prog .label { color: var(--xd-label-bright, #c4c4cc); }
`

class XdFxStatus extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #offs: Array<() => void> = []

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    this.#offs.push(
      on('param:change', ({ section, key, value }) => {
        if (key === 'on') this.#set(section, 'prog', value > 0)
      }),
      on('param:live', ({ section, key, value }) => {
        if (key === 'on') this.#set(section, 'live', value > 0)
      }),
      on('fx:active', ({ effect }) => this.#setActive(effect)),
    )
  }

  disconnectedCallback(): void {
    for (const off of this.#offs) off()
    this.#offs = []
  }

  #build(): void {
    adoptStyles(this.#shadow, styles)
    this.#shadow.innerHTML = EFFECTS.map(
      ({ label, section }) =>
        `<div class="fx" data-section="${section}" part="fx" role="button" tabindex="0"><span class="dot" part="dot"></span><span class="label">${label}</span></div>`,
    ).join('')
    this.setAttribute('role', 'group')
    this.setAttribute('aria-label', 'Effects — click to inspect')

    for (const row of this.#shadow.querySelectorAll<HTMLElement>('.fx')) {
      const select = (): void => {
        const effect = row.dataset.section
        if (effect) emit('fx:select', { effect })
      }
      row.addEventListener('click', select)
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      })
    }
  }

  #set(section: string, layer: 'prog' | 'live', active: boolean): void {
    const row = this.#shadow.querySelector(`.fx[data-section="${section}"]`)
    row?.classList.toggle(layer, active)
  }

  #setActive(effect: string): void {
    for (const row of this.#shadow.querySelectorAll<HTMLElement>('.fx')) {
      row.classList.toggle('active', row.dataset.section === effect)
    }
  }
}

define('xd-fx-status', XdFxStatus)
