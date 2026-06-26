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

// XD knobs sweep 270° total: -135° at min → +135° at max (0° points up).
export function knobAngle(value: number, sweep = 270): number {
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
    if (section === el.dataset.section && key === el.dataset.paramKey) {
      cb(value, display)
    }
  })
}
