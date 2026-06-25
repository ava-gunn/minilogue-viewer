#!/usr/bin/env bash
# Full local re-synthesis stack: the verify-and-tune daemon (background, connects to the XD
# via the Volt) + the Vite dev server (foreground). Ctrl-C stops the dev server, then the
# daemon. Extra args pass through to the daemon, e.g.:
#   pnpm local -- --tune-after 5
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Stop the daemon when the dev server exits (Ctrl-C, crash, or normal quit).
trap 'bash "$ROOT/scripts/daemon.sh" stop || true' EXIT

bash "$ROOT/scripts/daemon.sh" start "$@"
echo "── daemon started; launching web dev server (Ctrl-C stops both) ──"
pnpm -C "$ROOT/web" dev
