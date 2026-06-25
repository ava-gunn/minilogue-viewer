import { initialize, type ActivationContext } from "@ableton-extensions/sdk"
import { openBrowser } from "./open-browser.js"
import viewerHtml from "./viewer.generated.html"

const VIEWER_ID = "minilogue-xd-viewer.open"

// Object scopes the action appears under (mirrors harmony-track). The viewer isn't tied to
// Live data, so it's offered broadly; right-clicking any of these shows "minilogue xd viewer".
const SCOPES = [
  "AudioTrack",
  "MidiTrack",
  "AudioClip",
  "MidiClip",
  "ClipSlot",
  "Scene",
] as const

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0")

  context.commands.registerCommand(VIEWER_ID, async () => {
    try {
      // The viewer is bundled as a single self-contained HTML (no network, no model), shown
      // in a modal WebView. Its Resynthesis link posts {action:'open-url'} via the host
      // bridge, which closes the dialog and returns here — we then open the system browser.
      const result = await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(viewerHtml)}`,
        1300,
        860,
      )
      const data = JSON.parse(result) as { action?: string; url?: string }
      if (data.action === "open-url" && typeof data.url === "string") {
        openBrowser(data.url)
      }
    } catch {
      // dialog closed without a result — nothing to do
    }
  })

  for (const scope of SCOPES) {
    context.ui
      .registerContextMenuAction(scope, "Show viewer", VIEWER_ID)
      .catch((err) =>
        console.error("[minilogue-xd-viewer] failed to register", scope, err),
      )
  }
}
