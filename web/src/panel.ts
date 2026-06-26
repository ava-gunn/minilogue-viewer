import panelHtml from './panel.html?raw'

// Must run before initShared() queries controls, and after './components' is imported so the markup upgrades.
export function mountPanel(host: string | HTMLElement = 'panel-root'): void {
  const el = typeof host === 'string' ? document.getElementById(host) : host
  if (!el) throw new Error(`panel mount point not found: ${String(host)}`)
  el.innerHTML = panelHtml
}
