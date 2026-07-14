#!/usr/bin/env bash
# Diversity sweep on the XD: render the proxy-selected diverse patch set (training.data.select_diverse)
# across pitches. RESUMABLE — re-run the SAME command each night and it continues where it stopped,
# breaking cleanly between patches after MAX_HOURS. RUN MANUALLY (not scheduled). See memory
# diversity-sweep-plan + training/data/xd_record.py. Absolute paths so it runs from any cwd.
#
#   scripts/diversity-sweep.sh                      # an 8 h nightly slice
#   MAX_HOURS=0.03 OUT=/tmp/cal scripts/diversity-sweep.sh   # a short calibration slice elsewhere
set -euo pipefail

REPO="/Users/ava/Developer/minilogue-viewer"
PY="$REPO/training/.venv/bin/python"

# Config — override any of these in the environment.
: "${PATCHES:=/Volumes/Samples/training/xd_diverse/selected_units.npy}" # select_diverse output
: "${OUT:=/Volumes/Samples/training/xd_diverse}"                        # dataset dir (resume target)
: "${PITCHES:=24,36,48,60,72}"                                          # pitch axis (the proven lever)
: "${MAX_HOURS:=8}"                                                     # clean stop between patches
LOCK="$REPO/training/.sweep.lock"   # global: two xd_record procs would fight over the MIDI port
LOG="$OUT/.sweep.log"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

[ -x "$PY" ]      || { echo "venv python missing ($PY)"; exit 1; }
[ -f "$PATCHES" ] || { echo "patch set missing ($PATCHES) — run training.data.select_diverse"; exit 1; }
mkdir -p "$OUT"

# Single-instance lock (macOS has no flock; mkdir is atomic).
if ! mkdir "$LOCK" 2>/dev/null; then echo "another sweep holds $LOCK — exiting"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

cd "$REPO"
log "=== diversity sweep: pitches=$PITCHES max_hours=$MAX_HOURS out=$OUT ==="
# caffeinate keeps the long run alive: -i (idle) -m (disk) -s (while on AC).
caffeinate -i -m -s "$PY" -m training.data.xd_record \
  --patches "$PATCHES" --pitches "$PITCHES" --max-hours "$MAX_HOURS" --out "$OUT" "$@"
log "=== diversity sweep stopped (re-run to continue) ==="
