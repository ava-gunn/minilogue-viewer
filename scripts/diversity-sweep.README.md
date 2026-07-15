# Diversity sweep (manual, session-based)

Renders the proxy-selected diverse patch set (`training.data.select_diverse`) on the XD across
pitches, to expand the training set with maximally-spread, pitch-diverse patches. **Resumable**
and preflight-gated. Measured ~2.4 s/render → ~12k/night → **~6 nights** for the full 70k
(14k patches × 5 pitches).

It runs from your **logged-in session**, *not* launchd/cron (see "Why not a launchd cron" below).
Launch it in `tmux` from the repo root so it survives closing the window:

```sh
tmux new -d -s sweep 'bash scripts/sweep-nightly-loop.sh'
```

The loop waits until each **00:00**, runs one `diversity-sweep.sh` slice (≤ 8 h, stops cleanly
between patches), then waits for the next midnight. Manage it:

```sh
tmux attach -t sweep        # watch      (Ctrl-b d to detach)
tmux kill-session -t sweep  # stop
```

Logs: `training/.diversity-sweep.loop.log` (the loop) and `$OUT/.sweep.log` (per-run summary).

## Start collecting now (instead of waiting for midnight)

```sh
tmux new -d -s sweep-now 'bash scripts/diversity-sweep.sh'
```

`diversity-sweep.sh` is the single per-night slice — safe to run by hand anytime. It's resumable
(resumes by render count) so manual and looped runs share one dataset. A `mkdir` lock
(`training/.sweep.lock`) prevents overlapping runs.

## Preflight (what makes it bail)

1. **XD + Volt present** on MIDI/audio → if not, it **skips** (exit 0): nothing plugged in.
2. **Calibration-render RMS in `[CAL_MIN, CAL_MAX]`** (default `[0.025, 0.07]`) → if silent/too
   quiet or too hot, it **bails** (exit ≠ 0) before sweeping, so a bumped knob can't poison the set.

## Setup

- **XD** on USB (`minilogue xd SOUND` out / `minilogue xd KBD/KNOB` in), audio via `Volt 276`;
  venv at `training/.venv`.
- **Patch set** at `/Volumes/Samples/training/xd_diverse/selected_units.npy` (from
  `python -m training.data.select_diverse`).
- **Gain**: set the XD master out / Volt input so the calibration render lands around **0.042 RMS**
  (median clip peak ~0.19, headroom to ~0.66, no clipping). The preflight window is `[0.025, 0.07]`.
- **Wake** the Mac before midnight (launchd/loop won't wake a sleeping Mac):
  ```sh
  sudo pmset repeat wakeorpoweron MTWRFSU 23:58:00
  ```
- **Env overrides** (any of): `PATCHES`, `OUT`, `PITCHES`, `MAX_HOURS`, `CAL_MIN`, `CAL_MAX`.

## Why not a launchd cron

macOS TCC denies the **Microphone** to CLI tools launchd spawns — silently, with no grantable
entry (the venv python resolves into `Xcode.app`, a SIP binary), and it also `EPERM`s writes to
external `/Volumes`. A launchd run records pure silence (`rms 0.0000`). A `tmux` session launched
from a Microphone-granted terminal **inherits** the grant and records fine (verified). Trade-off:
the loop dies on **logout/reboot** — re-launch the one-liner after a restart.

## After collection

```sh
python -m training.data.embed --data /Volumes/Samples/training/xd_diverse
```

Then add `xd_diverse` to the retrain recipe's `--data` and A/B the result on the Drift eval.
