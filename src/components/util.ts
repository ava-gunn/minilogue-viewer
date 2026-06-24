/**
 * Adopt a stylesheet into a shadow root, falling back to a <style> element
 * where constructable stylesheets aren't supported (e.g. jsdom under Vitest).
 */
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

/**
 * Map a normalized 0..1 value to a knob's rotation. The XD knobs sweep 270°
 * total: -135° at minimum → +135° at maximum (0° points straight up).
 */
export function knobAngle(value: number, sweep = 270): number {
  return -sweep / 2 + clamp01(value) * sweep
}

/** Split a comma-separated attribute (e.g. "SQR,TRI,SAW") into trimmed parts. */
export function splitLabels(attr: string | null): string[] {
  if (!attr) return []
  return attr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Register a custom element once (tests re-import modules). */
export function define(name: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(name)) customElements.define(name, ctor)
}
