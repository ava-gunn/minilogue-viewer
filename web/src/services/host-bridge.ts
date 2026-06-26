// Bridge for running inside the Ableton extension's WebView. The modal can't submit forms,
// so the Resynthesis link asks the host (the Node extension) to open the deployed app in the
// system browser, and the Close button asks the host to dismiss the dialog.
//
// The message shape matches the Ableton SDK's modal channel: { method, params } where the
// payload becomes the showModalDialog() return value — which also closes the dialog.

interface HostBridge {
  postMessage(message: { method: string; params: string[] }): void
}

// The deployed web app; injected at build time since the embed runs from a data: URL with no
// origin of its own. The embed links here (resynthesis etc. live in the full web version).
const WEB_URL =
  import.meta.env.VITE_WEB_URL || 'https://minilogue-xd-viewer.vercel.app/'
// The embed is viewer-only; its "open in browser" link lands on the full app's Resynthesis form
// (single page now — ?resynth opens the form when the feature is enabled there).
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

/** Wire the embed chrome: the web-version link opens the deployed app in the system browser;
 *  Close dismisses the modal. */
export function initEmbed(): void {
  const link = document.querySelector<HTMLAnchorElement>('.embed-web-link')
  if (link) {
    link.href = RESYNTH_URL // reflect the configured URL (overridable at build time)
    link.addEventListener('click', (e) => {
      e.preventDefault()
      openExternal(RESYNTH_URL)
    })
  }

  document
    .querySelector<HTMLButtonElement>('#embed-close')
    ?.addEventListener('click', () => closeWindow())
}
