import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const root = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(root, "..", "web")
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))
const production = process.argv.includes("--production")

// Build the viewer-only single-file web app and inline it into the extension bundle, so the
// packaged .ablx is fully self-contained (no model, no network, no extra files to ship).
execFileSync("corepack", ["pnpm", "build:embed"], { cwd: webDir, stdio: "inherit" })
fs.copyFileSync(
  path.join(webDir, "dist-embed", "embed.html"),
  path.join(root, "src", "viewer.generated.html"),
)

await esbuild.build({
  entryPoints: [path.join(root, "src/extension.ts")],
  outfile: path.join(root, manifest.entry),
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
})
