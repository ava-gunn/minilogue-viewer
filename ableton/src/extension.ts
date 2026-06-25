import { initialize, type ActivationContext } from "@ableton-extensions/sdk"
import { openBrowser } from "./open-browser.js"
import viewerHtml from "./viewer.generated.html"

const VIEWER_ID = "minilogue-xd-viewer.open"

// The modal is a fixed-size window (the SDK has no auto-fit / post-open resize), so we size it
// for the tallest common layout: the synth (~455) plus an open library drawer (~747 total; the
// program list is capped + scrolls internally — see embed.css). A single program leaves some
// empty space below, which is unavoidable without a resize API.
const VIEWER_WIDTH = 1300
const VIEWER_HEIGHT = 770

// Every object scope the SDK exposes, so the action is reachable from a right-click
// essentially anywhere in Live (a right-click lands on one of these objects). The viewer
// isn't tied to Live data, so it's offered everywhere.
const SCOPES = [
  "AudioClip",
  "AudioTrack",
  "ClipSlot",
  "DrumRack",
  "MidiClip",
  "MidiTrack",
  "Sample",
  "Scene",
  "Simpler",
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
        VIEWER_WIDTH,
        VIEWER_HEIGHT,
      )
      // The viewer closes the dialog via close_and_send; "open-url" also opens the browser,
      // "close" just dismisses (nothing more to do here).
      const data = JSON.parse(result) as { action?: string; url?: string }
      if (data.action === "open-url" && typeof data.url === "string") {
        openBrowser(data.url)
      }
    } catch {
      // dialog closed without a result — nothing to do
    }
  })

  // Live prepends the manifest name, so this renders as "minilogue xd viewer: open".
  for (const scope of SCOPES) {
    context.ui
      .registerContextMenuAction(scope, "open", VIEWER_ID)
      .catch((err) =>
        console.error("[minilogue-xd-viewer] failed to register", scope, err),
      )
  }
}
