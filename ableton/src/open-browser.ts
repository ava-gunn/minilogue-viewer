import { spawn } from "node:child_process"

/** Open a URL in the system browser. The extension runs in Node (outside the WebView), so we
    shell out to the platform opener. Detached + unref so it outlives the extension call. */
export function openBrowser(url: string): void {
  if (process.platform === "win32") {
    // `start` is a cmd builtin; the empty first argument is the window title.
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref()
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open"
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref()
  }
}
