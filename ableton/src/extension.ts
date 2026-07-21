import { initialize, type ActivationContext } from "@ableton-extensions/sdk"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
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

const RATINGS_FILE = "ratings.json"

/** Load persisted star ratings from the extension's storage directory (empty if none/unavailable). */
async function loadRatings(dir: string | undefined): Promise<Record<string, number>> {
  if (!dir) return {}
  try {
    const parsed = JSON.parse(await readFile(join(dir, RATINGS_FILE), "utf8"))
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, number>)
      : {}
  } catch {
    return {} // missing on first run, or unreadable
  }
}

/** Persist star ratings to the extension's storage directory (best-effort). */
async function saveRatings(dir: string | undefined, ratings: unknown): Promise<void> {
  if (!dir || !ratings || typeof ratings !== "object") return
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, RATINGS_FILE), JSON.stringify(ratings), "utf8")
  } catch (err) {
    console.error("[minilogue-xd-viewer] failed to persist ratings", err)
  }
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0")

  context.commands.registerCommand(VIEWER_ID, async () => {
    // Live populates this at runtime; undefined under the standalone CLI (no persistence there).
    const storageDir = context.environment.storageDirectory
    try {
      // The viewer is bundled as a single self-contained HTML (no network, no model), shown in a
      // modal WebView. localStorage is blocked in its opaque data:-URL origin, so we seed prior
      // ratings as a global the bundle reads at startup; the viewer hands the updated map back on
      // close (host-bridge close_and_send payload), which we then persist.
      const ratings = await loadRatings(storageDir)
      const seed = `<script>window.__XD_RATINGS__=${JSON.stringify(ratings).replace(/</g, "\\u003c")}</script>`
      const html = viewerHtml.replace("<head>", `<head>${seed}`)

      // Its Resynthesis link posts {action:'open-url'} via the host bridge, which closes the dialog
      // and returns here — we then open the system browser.
      const result = await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(html)}`,
        VIEWER_WIDTH,
        VIEWER_HEIGHT,
      )
      // The viewer closes the dialog via close_and_send, returning { action, url?, ratings? }.
      const data = JSON.parse(result) as {
        action?: string
        url?: string
        ratings?: Record<string, number>
      }
      await saveRatings(storageDir, data.ratings)
      if (data.action === "open-url" && typeof data.url === "string") {
        openBrowser(data.url)
      }
    } catch {
      // dialog closed without a result (e.g. native window close) — this session's ratings aren't saved
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
