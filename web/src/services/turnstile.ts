// Lazy Cloudflare Turnstile loader. No-op (token undefined) when VITE_TURNSTILE_SITE_KEY is
// unset, so dev/local builds don't require a captcha.

const SITE_KEY = (import.meta.env as Record<string, string | undefined>)
  .VITE_TURNSTILE_SITE_KEY
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

interface TurnstileApi {
  render: (el: HTMLElement, opts: { sitekey: string }) => string
  getResponse: (id: string) => string | undefined
  reset: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

export const turnstileEnabled = (): boolean => Boolean(SITE_KEY)

let scriptPromise: Promise<void> | undefined
function loadScript(): Promise<void> {
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = SCRIPT_SRC
      s.async = true
      s.defer = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('failed to load Turnstile'))
      document.head.append(s)
    })
  }
  return scriptPromise
}

let widgetId: string | undefined

/** Render the widget into `container` once (no-op if disabled or already mounted). */
export async function mountTurnstile(container: HTMLElement): Promise<void> {
  if (!SITE_KEY || widgetId !== undefined) return
  await loadScript()
  // api.js can set window.turnstile a tick after onload; give it a moment.
  for (let i = 0; i < 40 && !window.turnstile; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (window.turnstile) {
    widgetId = window.turnstile.render(container, { sitekey: SITE_KEY })
  }
}

/** The current verification token, or undefined if disabled / unsolved. */
export function turnstileToken(): string | undefined {
  if (widgetId === undefined || !window.turnstile) return undefined
  return window.turnstile.getResponse(widgetId)
}

/** Reset after a submission so the next one needs a fresh solve. */
export function resetTurnstile(): void {
  if (widgetId !== undefined && window.turnstile)
    window.turnstile.reset(widgetId)
}
