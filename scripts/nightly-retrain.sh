#!/usr/bin/env bash
# Nightly, hardware-free: pull contributions -> embed -> proxy-gate -> (if any pass) finetune the
# encoder from the clean base on sweep + accepted contributions -> export web/public/models/model.onnx.
# Invoked by cron/launchd at midnight. All paths are absolute (cron runs with a minimal PATH).
# Install instructions: see scripts/nightly-retrain.README.md.
set -euo pipefail

REPO="/Users/ava/Developer/minilogue-viewer"
PY="$REPO/training/.venv/bin/python"
LOG="$REPO/training/.nightly.log"
LOCK="$REPO/training/.nightly.lock"

# Config — override any of these in the sourced env file or the environment ---------------------
: "${NIGHTLY_ENV:=$REPO/.env.nightly}"          # file exporting CONTRIB_API_URL/CONTRIB_ADMIN_TOKEN (+ optional overrides)
if [ -f "$NIGHTLY_ENV" ]; then set -a; . "$NIGHTLY_ENV"; set +a; fi
: "${SWEEP:=/Volumes/Samples/training/xd}"      # ground-truth Sobol sweep dataset
: "${PITCH:=/Volumes/Samples/training/xd_pitch}" # pitch-diverse sweep (24/36/48/72) — keeps retrains pitch-robust (see pitch-lever win)
: "${PRESETS:=/Volumes/Samples/training/presets}"        # real labeled presets — part of the shipped encoder recipe
: "${PRESETS_NEW:=/Volumes/Samples/training/presets_new}" # additional real presets — shipped recipe
: "${RUNS:=/Volumes/Samples/training/runs}"     # checkpoint dir
: "${PROXY:=$RUNS/proxy.pt}"                    # trained CLAP proxy (gate + frozen during finetune)
: "${BASE_ENCODER:=$RUNS/encoder.pt}"           # clean base encoder; warm-started fresh each night
: "${GATE_THRESHOLD:=0.5}"                      # min proxy/audio cosine to accept a submission
CONTRIB="$REPO/training/data/contrib"
ACCEPTED="$REPO/training/data/contrib_accepted"
NEW_ENCODER="$RUNS/encoder.nightly.pt"

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" ; }
fail() { log "FAILED at: $*"; exit 1 ; }

# Single-instance lock (macOS has no flock; mkdir is atomic) ------------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then log "another run holds $LOCK — exiting"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

cd "$REPO"
log "=== nightly retrain start ==="

# Preflight ------------------------------------------------------------------------------------
[ -x "$PY" ]           || fail "venv python missing ($PY)"
{ [ -n "${CONTRIB_API_URL:-}" ] && [ -n "${CONTRIB_ADMIN_TOKEN:-}" ]; } \
                       || fail "CONTRIB_API_URL / CONTRIB_ADMIN_TOKEN unset (put them in $NIGHTLY_ENV)"
[ -d "$SWEEP" ]        || fail "sweep dataset not mounted ($SWEEP)"
[ -d "$PITCH" ]        || fail "pitch sweep not mounted ($PITCH)"
[ -d "$PRESETS" ]      || fail "presets not mounted ($PRESETS)"
[ -d "$PRESETS_NEW" ]  || fail "presets_new not mounted ($PRESETS_NEW)"
[ -f "$PROXY" ]        || fail "proxy checkpoint missing ($PROXY)"
[ -f "$BASE_ENCODER" ] || fail "base encoder missing ($BASE_ENCODER)"

# 1. Pull + clear the Blob. Bail early (still cleared) if nothing new arrived -------------------
pull_out="$("$PY" -m training.data.pull_contributions 2>&1)" || fail "pull"
log "pull: ${pull_out//$'\n'/ | }"
if printf '%s' "$pull_out" | grep -q 'pulled 0 new'; then
  log "no new submissions — current model kept"; exit 0
fi

# 2. (Re)embed the full contrib audio -> embeddings.npy (pull invalidated the stale cache) ------
"$PY" -m training.data.embed --data "$CONTRIB" 2>&1 | tee -a "$LOG" || fail "embed"

# 3. Proxy-cosine gate -> training/data/contrib_accepted (accepted rows only) -------------------
gate_out="$("$PY" -m training.eval.gate_contrib \
  --data "$CONTRIB" --proxy "$PROXY" --threshold "$GATE_THRESHOLD" --out "$ACCEPTED" 2>&1)" || fail "gate"
log "gate: $gate_out"
if [ ! -s "$ACCEPTED/samples.jsonl" ]; then
  log "nothing passed the gate (threshold $GATE_THRESHOLD) — current model kept"; exit 0
fi

# 4. Finetune from the clean base on the full shipped recipe (sweep + presets + presets_new + pitch) + contributions
log "finetuning encoder -> $NEW_ENCODER"
"$PY" -m training.encoder_train \
  --data "$SWEEP" "$PRESETS" "$PRESETS_NEW" "$PITCH" "$ACCEPTED" --proxy "$PROXY" --init "$BASE_ENCODER" --out "$NEW_ENCODER" \
  2>&1 | tee -a "$LOG" || fail "encoder_train"

# 5. Export the browser model (export writes web/public/models/model.onnx atomically) -----------
"$PY" -m training.export --checkpoint "$NEW_ENCODER" 2>&1 | tee -a "$LOG" || fail "export"

log "=== nightly retrain done: web/public/models/model.onnx updated ==="
