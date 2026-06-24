import panelHtml from './panel.html?raw'

/** Inject the shared panel markup into a host element. Both pages call this so
    the panel exists before initShared() queries its controls. Components must
    already be registered (import './components') so the markup upgrades. */
export function mountPanel(host: string | HTMLElement = 'panel-root'): void {
  const el = typeof host === 'string' ? document.getElementById(host) : host
  if (!el) throw new Error(`panel mount point not found: ${String(host)}`)
  el.innerHTML = panelHtml
}
