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
  .row.on .led {
    background: var(--xd-led-on, #2dd4bf);
    box-shadow: 0 0 4px var(--xd-led-on, #2dd4bf), inset 0 0 0 1px #0008;
  }

  .led-label {
    font-size: 0.5rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }
  .row.on .led-label { color: var(--xd-label-bright, #c4c4cc); }

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
  #off: (() => void) | undefined
  #labels: string[] = []
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
    this.#apply(initial === null ? 0 : Number(initial))
  }

  #apply(index: number): void {
    const count = Math.max(this.#labels.length, 1)
    this.#active = Math.min(Math.max(Math.round(index), 0), count - 1)
    const rows = this.#shadow.querySelectorAll('.row')
    rows.forEach((el, i) => {
      el.classList.toggle('on', i === this.#active)
    })
    const group = this.getAttribute('label')
    const active = this.#labels[this.#active] ?? String(this.#active)
    this.setAttribute('aria-label', group ? `${group}: ${active}` : active)
  }
}

define('xd-led-group', XdLedGroup)
