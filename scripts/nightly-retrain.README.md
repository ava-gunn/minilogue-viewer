# Nightly retrain

`nightly-retrain.sh` runs, unattended, at midnight:

1. **pull** — `training.data.pull_contributions` fetches submissions from the deployed app and clears them from Vercel Blob (skips the rest if nothing new arrived).
2. **embed** — `training.data.embed` computes CLAP embeddings for the contrib audio.
3. **gate** — `training.eval.gate_contrib` scores each submission with the trained proxy (params → predicted embedding vs the audio's real embedding, cosine) and keeps those `≥ GATE_THRESHOLD` into `training/data/contrib_accepted/`.
4. **finetune** — if any passed, `training.encoder_train` warm-starts from the clean base encoder and trains on `SWEEP + contrib_accepted`.
5. **export** — `training.export` writes `web/public/models/model.onnx` (atomic).

No XD hardware required. Logs to `training/.nightly.log`; a `mkdir` lock (`training/.nightly.lock`) prevents overlapping runs.

## One-time setup

1. **Env** — create `/Users/ava/Developer/minilogue-viewer/.env.nightly` (gitignored via `.env.*`):
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
2. **Prereqs** the preflight checks: the venv at `training/.venv`, the sweep dataset mounted at `$SWEEP`, and `$PROXY` + `$BASE_ENCODER` present.
3. **Test it once by hand** before scheduling:
   ```sh
   scripts/nightly-retrain.sh; tail -n 40 training/.nightly.log
   ```

## Schedule it — option A: launchd (recommended on macOS)

Survives sleep (runs at next wake if asleep at midnight) and sees user-mounted volumes.

```sh
cp scripts/com.minilogue.nightly-retrain.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.minilogue.nightly-retrain.plist
launchctl list | grep minilogue            # confirm it's registered
# run it now to verify wiring:
launchctl start com.minilogue.nightly-retrain
# to remove:
launchctl unload ~/Library/LaunchAgents/com.minilogue.nightly-retrain.plist
```

## Schedule it — option B: cron

```sh
crontab -e
# add:
0 0 * * * /Users/ava/Developer/minilogue-viewer/scripts/nightly-retrain.sh >> /Users/ava/Developer/minilogue-viewer/training/.nightly.cron.log 2>&1
```

macOS caveats: grant `/usr/sbin/cron` **Full Disk Access** (System Settings ▸ Privacy & Security), cron **won't fire while the Mac is asleep**, and it may not see externally-mounted volumes. Prefer launchd.

## Tuning the gate

`GATE_THRESHOLD` is the min proxy/audio cosine to accept (`1 − cosine` is the proxy's own training loss). Start at `0.5`; inspect `training/data/contrib_accepted/gate.json` (per-submission cosines + the min/median/max) after a run and adjust. Lower = more permissive, higher = stricter.
