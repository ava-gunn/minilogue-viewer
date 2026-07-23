import { on } from '../events/bus'

export function adoptStyles(root: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  } catch {
    const style = document.createElement('style')
    style.textContent = css
    root.appendChild(style)
  }
}

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

// XD knobs sweep 285° total: -142.5° at min → +142.5° at max (0° points up) — a 75° dead zone at
// 6 o'clock, splitting the original 270° (90° gap) and the hardware-matched 300° (60° gap).
export function knobAngle(value: number, sweep = 285): number {
  return -sweep / 2 + clamp01(value) * sweep
}

export function splitLabels(attr: string | null): string[] {
  if (!attr) return []
  return attr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function define(name: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(name)) customElements.define(name, ctor)
}

export function onParam(
  event: 'param:change' | 'param:live',
  el: HTMLElement,
  cb: (value: number, display: string | undefined) => void,
): () => void {
  return on(event, ({ section, key, value, display }) => {
    if (section !== el.dataset.section || key !== el.dataset.paramKey) return
    // A locked control ignores live hardware knob turns — the needle stays frozen too.
    if (event === 'param:live' && el.classList.contains('locked')) return
    cb(value, display)
  })
}
