"""Render the factory presets from a .mnlgxdlib through the XD into a frozen eval set: one
note per preset, captured as ground-truth target audio and labeled with the preset's true
params. Skips the 'Init Program' blanks (keeps the 200 named factory presets).

    python -m training.eval.render_presets                # web/example-library.mnlgxdlib -> eval/set
    python -m training.eval.render_presets --limit 3      # smoke test (first 3 presets)

Resumable (skips presets whose target wav already exists) and idempotent (rewrites the
manifest's 'factory' rows, leaving any other cohorts intact). Each preset is forced to POLY
so the target is a single sustained note — the model can only predict POLY, so this makes
the resynthesis eval fair. Run from the repo root with the XD + Volt connected; needs the
record + eval extras.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import wave
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.eval import infer
from training.runtime import keep_awake
from training.xd_interface import XdInterface

RMS_FLOOR = 1e-3
_REPO = Path(__file__).resolve().parents[2]
_POLY = 0


def _write_wav_atomic(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    tmp = path.with_suffix(".wav.tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    tmp.replace(path)  # atomic: a crashed render never leaves a half-written target


def _preset_name(prog_bin: bytes) -> str:
    return prog_bin[4:16].decode("ascii", "replace").rstrip("\x00 ").strip()


def _is_init(name: str) -> bool:
    return (not name) or name.lower().startswith("init")


def _rewrite_factory_rows(manifest: Path, factory_rows: list[dict]) -> None:
    """Replace cohort=='factory' rows with factory_rows; keep every other cohort. Atomic."""
    other = [
        line
        for line in (manifest.read_text().splitlines() if manifest.exists() else [])
        if line.strip() and json.loads(line).get("cohort") != "factory"
    ]
    tmp = manifest.with_suffix(".jsonl.tmp")
    tmp.write_text("\n".join(other + [json.dumps(r) for r in factory_rows]) + "\n")
    tmp.replace(manifest)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lib", type=Path, default=_REPO / "web" / "example-library.mnlgxdlib")
    ap.add_argument("--out", type=Path, default=_REPO / "training" / "eval" / "set")
    ap.add_argument("--note", default="C4", help="pitch to render each preset at")
    ap.add_argument("--limit", type=int, help="render only the first N presets (smoke test)")
    ap.add_argument("--include-init", action="store_true", help="don't skip Init Program blanks")
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--gate", type=float, default=0.6)
    ap.add_argument("--settle", type=float, default=0.1)
    ap.add_argument("--recal", type=int, default=50, help="recalibrate every N renders")
    args = ap.parse_args()

    # A kill (SIGTERM) should still run the finally below (benign patch + panic + close).
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    midi = infer.note_to_midi(args.note)
    sr = schema.AUDIO["sample_rate"]
    dur = schema.AUDIO["duration_s"]
    targets = args.out / "targets"
    targets.mkdir(parents=True, exist_ok=True)

    blobs = korg.extract_prog_bins(args.lib)
    kept = [
        (i, b) for i, b in enumerate(blobs) if args.include_init or not _is_init(_preset_name(b))
    ]
    if args.limit:
        kept = kept[: args.limit]
    print(f"{len(blobs)} prog_bins in {args.lib.name}; {len(kept)} presets to render at {args.note}")

    template = korg.extract_prog_bins(infer.DEFAULT_TEMPLATE)[0]
    xd = XdInterface(
        midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=sr
    )

    def calibrate() -> float:
        xd.send_patch(template, settle_s=args.settle)
        return float(np.sqrt(np.mean(xd.record(note=60, gate_s=args.gate, duration_s=dur) ** 2)))

    rows: list[dict] = []
    silent = 0
    try:
        cal = calibrate()
        print(f"calibration rms={cal:.4f}")
        if cal < RMS_FLOOR:
            raise RuntimeError("calibration silent — check XD power/volume + Volt input gain")

        with keep_awake():
            for n, (slot, prog_bin) in enumerate(kept):
                sid = f"factory_{n:03d}"
                name = _preset_name(prog_bin)
                raw = xd_params.read_params(prog_bin)
                raw["voice_mode"] = _POLY  # single sustained note (model only predicts POLY)
                wav_path = targets / f"{sid}.wav"

                if wav_path.exists():  # resume: reuse the already-rendered target
                    rms = float(np.sqrt(np.mean(infer.load_audio(wav_path) ** 2)))
                else:
                    xd.send_patch(xd_params.write_params(prog_bin, raw), settle_s=args.settle)
                    audio = xd.record(note=midi, gate_s=args.gate, duration_s=dur)
                    rms = float(np.sqrt(np.mean(audio**2)))
                    if rms < RMS_FLOOR:  # uninformative target — leave it out of the set
                        silent += 1
                        print(f"  {sid} {name!r}: silent (rms={rms:.5f}) — dropped")
                        continue
                    _write_wav_atomic(wav_path, audio, sr)

                rows.append(
                    {
                        "id": sid,
                        "source_path": str(wav_path.resolve()),
                        "cohort": "factory",
                        "name": name,
                        "lib_slot": slot,
                        "pitch_midi": midi,
                        "rms": round(rms, 5),
                        "true_raw": raw,
                    }
                )
                if (n + 1) % args.recal == 0:
                    drift = calibrate()
                    print(f"  [{n + 1}/{len(kept)}] recal rms={drift:.4f}")
                    if drift < RMS_FLOOR:
                        raise RuntimeError("calibration went silent mid-run — aborting")
    finally:
        # Leave a benign patch so no preset sits self-oscillating, then panic + close.
        try:
            xd.send_patch(template, settle_s=0.05)
        finally:
            xd.close()

    _rewrite_factory_rows(args.out / "manifest.jsonl", rows)
    print(
        f"wrote {len(rows)} factory rows to {args.out / 'manifest.jsonl'} "
        f"({silent} silent dropped); targets in {targets}"
    )


if __name__ == "__main__":
    main()
