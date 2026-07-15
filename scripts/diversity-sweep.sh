#!/usr/bin/env bash
# Diversity sweep on the XD: render the proxy-selected diverse patch set (training.data.select_diverse)
# across pitches. RESUMABLE — re-run the SAME command each night and it continues where it stopped,
# breaking cleanly between patches after MAX_HOURS. Safe to run manually or from the midnight
# LaunchAgent (com.minilogue.diversity-sweep). See memory diversity-sweep-plan + xd_record.py.
#
# Preflight (bails, does NOT sweep, if either fails):
#   1. XD + Volt present on MIDI/audio        -> benign skip (exit 0): nothing plugged in tonight.
#   2. calibration render RMS in [CAL_MIN,CAL_MAX] -> misconfig (exit != 0): gain drifted / knob bumped.
#
#   scripts/diversity-sweep.sh                                   # an 8 h nightly slice
#   MAX_HOURS=0.02 OUT=/tmp/cal scripts/diversity-sweep.sh       # a short slice elsewhere
set -uo pipefail   # NOT -e: the sweep's exit status is handled explicitly below

REPO="/Users/ava/Developer/minilogue-viewer"
PY="$REPO/training/.venv/bin/python"

# Config — override any of these in the environment.
: "${PATCHES:=/Volumes/Samples/training/xd_diverse/selected_units.npy}" # select_diverse output
: "${OUT:=/Volumes/Samples/training/xd_diverse}"                        # dataset dir (resume target)
: "${PITCHES:=24,36,48,60,72}"                                          # pitch axis (the proven lever)
: "${MAX_HOURS:=8}"                                                     # clean stop between patches
: "${CAL_MIN:=0.025}"   # calibration-render RMS floor (below = silent/too quiet; good gain ~0.042)
: "${CAL_MAX:=0.07}"    # calibration-render RMS ceiling (above = too hot / clipping)
LOCK="$REPO/training/.sweep.lock"   # global: two xd_record procs would fight over the MIDI port
LOG="$OUT/.sweep.log"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; { [ -d "$OUT" ] && printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; } 2>/dev/null || true; }

[ -x "$PY" ]      || { echo "venv python missing ($PY)"; exit 1; }
[ -f "$PATCHES" ] || { echo "patch set missing ($PATCHES) — run training.data.select_diverse"; exit 1; }
mkdir -p "$OUT" 2>/dev/null || true

# Single-instance lock (macOS has no flock; mkdir is atomic).
if ! mkdir "$LOCK" 2>/dev/null; then echo "another sweep holds $LOCK — exiting"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
cd "$REPO"

# Preflight 1 — XD + Volt present? Cheap (no render). Not plugged in tonight = benign skip.
if ! "$PY" - <<'PY'
import sys
try:
    import mido, sounddevice as sd
    outs, ins = set(mido.get_output_names()), set(mido.get_input_names())
    audio = " ".join(d["name"] for d in sd.query_devices())
    ok = ("minilogue xd SOUND" in outs and "minilogue xd KBD/KNOB" in ins and "Volt 276" in audio)
except Exception as e:
    print(f"preflight device check errored: {e}", file=sys.stderr); ok = False
sys.exit(0 if ok else 1)
PY
then
  log "preflight: XD/Volt not connected — skipping tonight"
  exit 0
fi

log "=== diversity sweep: pitches=$PITCHES max_hours=$MAX_HOURS cal_window=[$CAL_MIN,$CAL_MAX] out=$OUT ==="
# Preflight 2 lives in xd_record's calibration render: it bails (non-zero) before sweeping if the
# recorded level is outside [CAL_MIN,CAL_MAX]. caffeinate keeps the long run alive: -i -m -s.
caffeinate -i -m -s "$PY" -m training.data.xd_record \
  --patches "$PATCHES" --pitches "$PITCHES" --max-hours "$MAX_HOURS" --out "$OUT" \
  --cal-min-rms "$CAL_MIN" --cal-max-rms "$CAL_MAX" "$@"
status=$?
if [ "$status" -eq 0 ]; then
  log "=== diversity sweep stopped cleanly (re-run to continue) ==="
else
  log "=== diversity sweep BAILED (exit $status) — level gate or hardware error, see output above ==="
fi
exit "$status"
