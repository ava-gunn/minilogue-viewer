// Bridge for the Ableton extension's WebView. Message shape matches the Ableton SDK's modal
// channel: { method, params } where the payload becomes the showModalDialog() return value
// (which also closes the dialog).

interface HostBridge {
  postMessage(message: { method: string; params: string[] }): void
}

// Injected at build time: the embed runs from a data: URL with no origin of its own.
const WEB_URL =
  import.meta.env.VITE_WEB_URL || 'https://minilogue-xd-viewer.vercel.app/'
// ?resynth opens the Resynthesis form on the full app.
const RESYNTH_URL = `${WEB_URL}?resynth=1`

function host(): HostBridge | undefined {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { live?: HostBridge } }
    chrome?: { webview?: HostBridge }
  }
  return w.webkit?.messageHandlers?.live ?? w.chrome?.webview
}

/** Post a payload that closes the modal and returns it to the host. Returns false if there's
 *  no host (a normal browser), so callers can fall back. */
function sendAndClose(payload: Record<string, unknown>): boolean {
  const bridge = host()
  if (!bridge) return false
  bridge.postMessage({
    method: 'close_and_send',
    params: [JSON.stringify(payload)],
  })
  return true
}

/** Open a URL in the system browser via the Ableton host; fall back to a new tab. */
export function openExternal(url: string): void {
  if (!sendAndClose({ action: 'open-url', url })) {
    window.open(url, '_blank', 'noopener')
  }
}

/** Close the modal via the host; fall back to window.close() in a normal browser. */
export function closeWindow(): void {
  if (!sendAndClose({ action: 'close' })) window.close()
}

export function initEmbed(): void {
  const link = document.querySelector<HTMLAnchorElement>('.embed-web-link')
  if (link) {
    link.href = RESYNTH_URL
    link.addEventListener('click', (e) => {
      e.preventDefault()
      openExternal(RESYNTH_URL)
    })
  }

  document
    .querySelector<HTMLButtonElement>('#embed-close')
    ?.addEventListener('click', () => closeWindow())
}
