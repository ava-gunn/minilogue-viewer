import { adoptStyles, define, onParam } from './util'

// Displayed top → bottom as on the hardware: SAW, TRI, SQR. `value` is the
// program enum (0=SQR, 1=TRI, 2=SAW), so highlight + position by value.
const WAVES = [
  { value: 2, label: 'SAW', path: 'M1 10 L6 2 V10 L12 2 V10 L18 2 V10' },
  { value: 1, label: 'TRI', path: 'M1 10 L6 2 L11 10 L16 2 L21 10' },
  { value: 0, label: 'SQR', path: 'M1 10 H5 V2 H11 V10 H17 V2 H23' },
] as const

const slotOf = (value: number): number => {
  const i = WAVES.findIndex((w) => w.value === value)
  return i < 0 ? 0 : i
}

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

  /* Circle (program) + ring (synth) markers that slide to the active slot. */
  .marker {
    position: absolute;
    left: 50%;
    box-sizing: border-box;
    --slot-h: calc((var(--xd-toggle-h, 2rem) - 4px) / 3);
    --marker-d: min(var(--slot-h), calc(var(--xd-toggle-w, 0.85rem) - 4px));
    inline-size: var(--marker-d);
    block-size: var(--marker-d);
    top: calc(2px + (var(--slot-h) - var(--marker-d)) / 2);
    border-radius: 50%;
    transition: transform var(--wa-transition-normal, 0.15s) ease;
  }
  .marker.program {
    background: var(--xd-knob-teal, #2dd4bf);
    box-shadow: 0 0 4px var(--xd-knob-teal, #2dd4bf);
    transform: translateX(-50%) translateY(calc(var(--active, 0) * var(--slot-h)));
  }
  .marker.live {
    background: transparent;
    outline: 1.5px solid var(--xd-knob-live, #f6a821);
    outline-offset: 1px;
    transform: translateX(-50%) translateY(calc(var(--active-live, 0) * var(--slot-h)));
  }
  :host(:not([live])) .marker.live { display: none; }

  .ticks {
    display: flex;
    flex-direction: column;
    /* space-around centers each glyph in its slot to line up with the marker. */
    justify-content: space-around;
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
    .lever, .marker { transition: none; }
  }
`

class XdWaveSelector extends HTMLElement {
  #shadow = this.attachShadow({ mode: 'open' })
  #built = false
  #offs: Array<() => void> = []
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
    const label = this.getAttribute('label') ?? 'WAVE'
    const ticks = WAVES.map(
      (w) =>
        `<span class="wave" data-value="${w.value}"><svg viewBox="0 0 24 12" aria-hidden="true"><path d="${w.path}"/></svg></span>`,
    ).join('')
    this.#shadow.innerHTML = `<div class="switch"><div class="track" part="track"><span class="marker program" part="marker"></span><span class="marker live" part="marker-live"></span></div><div class="ticks" part="ticks">${ticks}</div></div><span class="label" part="label">${label}</span>`
    this.setAttribute('role', 'img')
    const initial = this.getAttribute('value')
    this.#applyProgram(initial === null ? 0 : Number(initial))
  }

  #clamp(value: number): number {
    return Math.min(Math.max(Math.round(value), 0), WAVES.length - 1)
  }

  #applyProgram(value: number): void {
    this.#program = this.#clamp(value)
    this.style.setProperty('--active', String(slotOf(this.#program)))
    for (const el of this.#shadow.querySelectorAll('.wave')) {
      el.classList.toggle(
        'on',
        Number(el.getAttribute('data-value')) === this.#program,
      )
    }
    this.#updateAria()
  }

  #applyLive(value: number): void {
    this.#live = this.#clamp(value)
    this.setAttribute('live', '')
    this.style.setProperty('--active-live', String(slotOf(this.#live)))
    this.#updateAria()
  }

  #updateAria(): void {
    const label = this.getAttribute('label') ?? 'WAVE'
    const prog = WAVES.find((w) => w.value === this.#program)?.label ?? ''
    const live = WAVES.find((w) => w.value === this.#live)?.label ?? ''
    const readout =
      this.#live >= 0 && this.#live !== this.#program
        ? `${prog} (hardware ${live})`
        : prog
    this.setAttribute('aria-label', `${label}: ${readout}`)
  }
}

define('xd-wave-selector', XdWaveSelector)
