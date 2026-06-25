// Bridge for running inside the Ableton extension's WebView. The viewer is shown in a modal
// that can't submit forms, so the Resynthesis link asks the host (the Node extension) to open
// the deployed app in the system browser. In a normal browser there's no host → open a tab.
//
// The message shape matches the Ableton SDK's modal channel: { method, params } where the
// payload becomes the showModalDialog() return value (which then closes the dialog).

interface HostBridge {
  postMessage(message: { method: string; params: string[] }): void
}

// The deployed resynth page; injected at build time since the embed runs from a data: URL
// with no origin of its own.
const RESYNTH_URL =
  import.meta.env.VITE_RESYNTH_URL ||
  'https://minilogue-viewer.vercel.app/resynth.html'

function host(): HostBridge | undefined {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { live?: HostBridge } }
    chrome?: { webview?: HostBridge }
  }
  return w.webkit?.messageHandlers?.live ?? w.chrome?.webview
}

/** Open a URL in the system browser via the Ableton host; fall back to a new tab. */
export function openExternal(url: string): void {
  const bridge = host()
  if (bridge) {
    bridge.postMessage({
      method: 'close_and_send',
      params: [JSON.stringify({ action: 'open-url', url })],
    })
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/** Wire the Resynthesis link to open the deployed app externally instead of navigating. */
export function initEmbedLink(): void {
  const link = document.querySelector<HTMLAnchorElement>('.resynth-link')
  link?.addEventListener('click', (e) => {
    e.preventDefault()
    openExternal(RESYNTH_URL)
  })
}
