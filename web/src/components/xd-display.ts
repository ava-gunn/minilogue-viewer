import { on } from '../events/bus'
import { acceptFile, DEFAULT_ACCEPT } from '../events/files'
import { adoptStyles, define } from './util'

const styles = `
  :host {
    display: inline-flex;
    flex-direction: column;
    font-family: var(--xd-font);
    outline: none;
  }

  .screen {
    background: var(--xd-oled-bg, #050507);
    color: var(--xd-oled-text, #e6f2f0);
    border-radius: 0.35rem;
    padding: 0.4rem 0.7rem;
    border: 1px solid transparent;
    box-shadow: inset 0 0 0 1px #0009, inset 0 0 12px #00000080;
    min-width: 9rem;
    cursor: pointer;
    transition: border-color var(--wa-transition-normal, 0.15s) ease;
  }
  .screen:hover,
  :host(:focus-visible) .screen { border-color: var(--xd-knob-teal, #2dd4bf); }
  :host([dragover]) .screen {
    border-color: var(--xd-knob-teal, #2dd4bf);
    background: #0b1a18;
  }

  .name {
    font-size: 1rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    opacity: 0.7;
  }

  input { display: none; }
`

class XdDisplay extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #off: (() => void) | undefined
  #input!: HTMLInputElement

  connectedCallback(): void {
    if (!this.#built) {
      this.#build()
      this.#built = true
    }
    this.#off = on('patch:load', ({ patch, index, total }) => {
      this.setProgram(patch.name, index, total)
    })
  }

  disconnectedCallback(): void {
    this.#off?.()
    this.#off = undefined
  }

  #build(): void {
    adoptStyles(this.#shadow, styles)
    const accept = this.getAttribute('accept') ?? DEFAULT_ACCEPT
    // The file input lives inside the <label>, so a plain click opens the picker via native
    // label activation — a programmatic input.click() is blocked in some embedded WebViews
    // (e.g. Ableton's WKWebView). The input stays display:none so it never intercepts drops.
    this.#shadow.innerHTML = `<label class="screen" part="screen"><div class="name" part="name">INIT PROGRAM</div><div class="meta" part="meta"><span class="index"></span><span class="hint">click or drop a patch</span></div><input type="file" accept="${accept}" /></label>`
    this.#input = this.#shadow.querySelector('input') as HTMLInputElement
    this.setAttribute('role', 'button')
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0')
    this.#updateAria('INIT PROGRAM')

    // Mouse: the native <label> opens the picker. Keyboard: fall back to a click() (the host
    // is role=button/tabindex=0), which works in regular browsers.
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.#input.click()
      }
    })
    this.#input.addEventListener('change', () => {
      const file = this.#input.files?.[0]
      if (file) acceptFile(file, accept)
      this.#input.value = ''
    })
    this.addEventListener('dragover', (e) => {
      e.preventDefault()
      this.setAttribute('dragover', '')
    })
    this.addEventListener('dragleave', () => this.removeAttribute('dragover'))
    this.addEventListener('drop', (e) => {
      e.preventDefault()
      this.removeAttribute('dragover')
      const file = e.dataTransfer?.files?.[0]
      if (file) acceptFile(file, accept)
    })
  }

  setProgram(name: string, index: number, total: number): void {
    const display = name || 'INIT PROGRAM'
    const nameEl = this.#shadow.querySelector('.name')
    const indexEl = this.#shadow.querySelector('.index')
    const hintEl = this.#shadow.querySelector('.hint')
    if (nameEl) nameEl.textContent = display
    if (indexEl)
      indexEl.textContent = total > 1 ? `${index + 1} / ${total}` : ''
    if (hintEl) hintEl.textContent = ''
    this.#updateAria(display)
  }

  #updateAria(name: string): void {
    this.setAttribute(
      'aria-label',
      `Program: ${name}. Click or drop a patch file to load.`,
    )
  }
}

define('xd-display', XdDisplay)
