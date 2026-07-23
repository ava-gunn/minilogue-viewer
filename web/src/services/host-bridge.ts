// Bridge for the Ableton extension's WebView. Message shape matches the Ableton SDK's modal
// channel: { method, params } where the payload becomes the showModalDialog() return value
// (which also closes the dialog).

import { getAllRatings } from './ratings'

interface HostBridge {
  postMessage(message: { method: string; params: string[] }): void
}

// Injected at build time: the embed runs from a data: URL with no origin of its own.
const WEB_URL =
  import.meta.env.VITE_WEB_URL || 'https://minilogue-xd-viewer.vercel.app/'

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
  // Ride the current ratings map out on every close so the host can persist it — the modal's
  // opaque data:-URL origin can't write to disk itself.
  bridge.postMessage({
    method: 'close_and_send',
    params: [JSON.stringify({ ...payload, ratings: getAllRatings() })],
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

/** Base64-encode bytes for transport through the string-only host channel. */
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Ask the Ableton host to save bytes to a file (it writes to the extension's storage folder and
 *  reveals it in Finder). Returns false in a normal browser so callers fall back to a download.
 *  Closes the modal — the SDK's only host channel (close_and_send) does. */
export function saveFile(filename: string, bytes: Uint8Array): boolean {
  return sendAndClose({
    action: 'save-file',
    filename,
    contents: toBase64(bytes),
  })
}

export function initEmbed(): void {
  const link = document.querySelector<HTMLAnchorElement>('.embed-web-link')
  if (link) {
    link.href = WEB_URL
    link.addEventListener('click', (e) => {
      e.preventDefault()
      openExternal(WEB_URL)
    })
  }

  document
    .querySelector<HTMLButtonElement>('#embed-close')
    ?.addEventListener('click', () => closeWindow())

  // Escape closes the modal (dialog convention); the host manages focus return.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWindow()
  })
}
