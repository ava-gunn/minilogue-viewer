# Retrain pipeline (manual)

`nightly-retrain.sh` is run **by hand** when you want to fold new submissions into the model.
It is **not scheduled** — there is no cron or launchd job. (Collecting + clearing submissions is
likewise manual; see below.)

```sh
scripts/nightly-retrain.sh; tail -n 40 training/.nightly.log
```

Steps:

1. **pull** — `training.data.pull_contributions` fetches submissions from the deployed app and clears them from Vercel Blob (skips the rest if nothing new arrived).
2. **embed** — `training.data.embed` computes CLAP embeddings for the contrib audio.
3. **gate** — `training.eval.gate_contrib` scores each submission with the trained proxy (params → predicted embedding vs the audio's real embedding, cosine) and keeps those `≥ GATE_THRESHOLD` into `training/data/contrib_accepted/`.
4. **finetune** — if any passed, `training.encoder_train` warm-starts from the clean base encoder and trains on the full recipe (`SWEEP + presets + presets_new + xd_pitch + contrib_accepted`).
5. **export** — `training.export` writes `web/public/models/model.onnx` (atomic).

No XD hardware required. Logs to `training/.nightly.log`; a `mkdir` lock (`training/.nightly.lock`) prevents overlapping runs.

## Collect + clear submissions only (without retraining)

Collection and clearing are a standalone manual command — run it whenever you want to pull the
form submissions off Vercel Blob and clear them (or `--no-clear` to keep them on Blob):

```sh
python -m training.data.pull_contributions            # pull + clear
python -m training.data.pull_contributions --no-clear # pull, leave on Blob
```

It writes the local `contrib` split + a `.pulled` ledger and is idempotent (re-deletes any
ledgered id still present on Blob). Requires `CONTRIB_API_URL` + `CONTRIB_ADMIN_TOKEN` (below).

## Setup

**Env** — create `/Users/ava/Developer/minilogue-viewer/.env.nightly` (gitignored via `.env.*`):
```sh
CONTRIB_API_URL=https://minilogue-xd-viewer.vercel.app
CONTRIB_ADMIN_TOKEN=<same token set in Vercel>
# optional overrides (defaults shown):
# SWEEP=/Volumes/Samples/training/xd
# RUNS=/Volumes/Samples/training/runs
# PROXY=$RUNS/proxy.pt
# BASE_ENCODER=$RUNS/encoder.pt
# GATE_THRESHOLD=0.5
```
`pull_contributions` also reads `CONTRIB_API_URL` / `CONTRIB_ADMIN_TOKEN` from the environment if
you run it standalone (outside the pipeline script).

**Prereqs** the preflight checks: the venv at `training/.venv`, the sweep dataset mounted at `$SWEEP`, and `$PROXY` + `$BASE_ENCODER` present.

## Tuning the gate

`GATE_THRESHOLD` is the min proxy/audio cosine to accept (`1 − cosine` is the proxy's own training loss). Start at `0.5`; inspect `training/data/contrib_accepted/gate.json` (per-submission cosines + the min/median/max) after a run and adjust. Lower = more permissive, higher = stricter.
