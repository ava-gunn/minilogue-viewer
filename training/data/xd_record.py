"""XD recording rig: load randomized patches into the Minilogue XD, play a gated C4,
record the output, and write (audio, param-target) pairs — the fine-tune dataset.

    python -m training.data.xd_record --n 2000 --out /Volumes/Samples/training/xd

Unattended + resumable (samples.jsonl appended/flushed per sample); runs under a keep-awake
assertion; preflights disk + a calibration render before the long run. Run from repo root.
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
from training.runtime import keep_awake, preflight_disk
from training.xd_interface import XdInterface

RMS_FLOOR = 1e-3
_REPO = Path(__file__).resolve().parents[2]


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _count_done(out: Path) -> int:
    jsonl = out / "samples.jsonl"
    return sum(1 for _ in jsonl.open()) if jsonl.exists() else 0


def _write_meta(out: Path, gate: float, duration: float, pitches: list[int]) -> None:
    out.joinpath("meta.json").write_text(
        json.dumps(
            {
                "continuous": [p["id"] for p in schema.CONTINUOUS],
                "discrete": [{"id": p["id"], "cardinality": p["cardinality"]} for p in schema.DISCRETE],
                "boolean": [p["id"] for p in schema.BOOLEAN],
                "sample_rate": schema.AUDIO["sample_rate"],
                "gate_s": gate,
                "duration_s": duration,
                "pitches": pitches,
            }
        )
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=2000, help="total target sample count")
    ap.add_argument("--out", type=Path, default=Path("/Volumes/Samples/training/xd"))
    ap.add_argument(
        "--template", type=Path, default=_REPO / "web" / "replicant-example.mnlgxdprog"
    )
    ap.add_argument("--gate", type=float, default=0.6)
    ap.add_argument("--duration", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=0)
    # USB MIDI to the Korg's sound engine (no DIN baud bottleneck); audio via the Volt.
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--settle", type=float, default=0.1, help="post-dump settle (0.1 for USB)")
    # Record each patch at several pitches -> pitch-invariant model + more data.
    ap.add_argument("--pitches", default="36,60,84", help="MIDI notes per patch (e.g. C2,C4,C6)")
    args = ap.parse_args()

    # A kill (SIGTERM) should still run the finally below (close -> panic) so a note
    # can't stick; SystemExit unwinds the stack, plain SIGTERM does not.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    pitches = [int(p) for p in args.pitches.split(",")]
    out = args.out
    (out / "audio").mkdir(parents=True, exist_ok=True)
    preflight_disk(out, need_gb=1.0)
    _write_meta(out, args.gate, args.duration, pitches)
    template = korg.extract_prog_bins(args.template)[0]

    sr = schema.AUDIO["sample_rate"]
    xd = XdInterface(
        midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=sr
    )
    try:
        # Calibration / preflight: load the template and confirm we actually capture sound
        # before committing to a long unattended run.
        xd.send_patch(template, settle_s=args.settle)
        cal_rms = float(np.sqrt(np.mean(xd.record(gate_s=args.gate, duration_s=args.duration) ** 2)))
        print(f"calibration rms={cal_rms:.4f}")
        if cal_rms < RMS_FLOOR:
            raise RuntimeError(
                "calibration silent — check Korg power/volume + Volt input gain/connection"
            )

        # Resume by render count, aligned to whole patches (drop a partial patch's
        # renders from a prior crash so labels/ids stay consistent).
        start = _count_done(out)
        whole = (start // len(pitches)) * len(pitches)
        if whole != start:
            lines = (out / "samples.jsonl").read_text().splitlines()[:whole]
            (out / "samples.jsonl").write_text("\n".join(lines) + ("\n" if lines else ""))
            start = whole
        if start >= args.n:
            print(f"already have {start} >= {args.n} renders at {out}")
            return
        patches_done = start // len(pitches)
        print(f"resuming at {start} renders ({patches_done} patches), target {args.n}; pitches {pitches}")
        rng = np.random.default_rng(args.seed + patches_done)

        kept = start
        with keep_awake(), (out / "samples.jsonl").open("a") as manifest:
            while kept < args.n:
                prog_bin, targets = xd_params.randomize(template, rng)
                xd.send_patch(prog_bin, settle_s=args.settle)
                lines = []
                for pitch in pitches:  # same patch + labels, different note
                    audio = xd.record(note=pitch, gate_s=args.gate, duration_s=args.duration)
                    rms = float(np.sqrt(np.mean(audio**2)))
                    _write_wav(out / "audio" / f"{kept:06d}.wav", audio, sr)
                    lines.append(json.dumps({"id": kept, "pitch": pitch, "rms": rms, **targets}))
                    kept += 1
                manifest.write("\n".join(lines) + "\n")  # whole patch flushed together
                manifest.flush()
                if kept % 30 == 0:
                    print(f"{kept}/{args.n} renders")
        print(f"done: {kept} renders at {out}")
    finally:
        # Leave a benign patch loaded so a final high-resonance random patch can't sit
        # there self-oscillating; then panic + close.
        try:
            xd.send_patch(template, settle_s=0.05)
        finally:
            xd.close()


if __name__ == "__main__":
    main()
