import { adoptStyles, define, onParam } from './util'

const styles = `
  :host {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: var(--wa-space-2xs, 0.25rem);
    font-family: var(--xd-font);
  }

  .lcd {
    min-width: 3.5rem;
    padding: 0.4rem 0.4rem;
    border-radius: 3px;
    background: var(--xd-lcd-bg, #04060a);
    color: var(--xd-lcd-text, #e6f2f0);
    box-shadow: inset 0 0 0 1px #0009, inset 0 0 6px #00000080;
    font-size: 0.7rem;
    letter-spacing: 0.12em;
    text-align: center;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .label {
    font-size: 0.5rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--xd-label-color, #8a8a92);
  }
`

class XdLcd extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #offs: Array<() => void> = []

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    const set = (value: number, display: string | undefined): void =>
      this.#set(display ?? String(value))
    this.#offs.push(
      onParam('param:change', this, set),
      onParam('param:live', this, set),
    )
  }

  disconnectedCallback(): void {
    for (const off of this.#offs) off()
    this.#offs = []
  }

  #build(): void {
    adoptStyles(this.#shadow, styles)
    const label = this.getAttribute('label')
    const footer = label ? `<span class="label">${label}</span>` : ''
    this.#shadow.innerHTML = `<span class="lcd" part="lcd">${this.getAttribute('placeholder') ?? '----'}</span>${footer}`
    this.setAttribute('role', 'status')
    this.setAttribute('aria-live', 'polite')
  }

  #set(text: string): void {
    const lcd = this.#shadow.querySelector('.lcd')
    if (lcd) lcd.textContent = text
    this.setAttribute('aria-label', text)
  }
}

define('xd-lcd', XdLcd)
