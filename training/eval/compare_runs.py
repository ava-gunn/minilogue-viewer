"""Model-comparison eval gate — "is this change an improvement?"

For a FIXED target set, render each model checkpoint's predicted patch on the real XD and
score it with audio_distance (the same signal refine.py optimizes). Reports a per-target +
mean table; with exactly two models it adds a per-target delta and an improvement verdict.

    python -m training.eval.compare_runs --models web/public/models/model.onnx runs/new.onnx \
        --targets datasets/nsynth-test/audio/bass_synthetic_009-054-100.wav ... --lowpass 8000

Each target is rendered at its own pitch: NSynth-style filename (..._<instr>-<midi>-<vel>.wav)
-> that MIDI note; else --detect-pitch (pyin); else --pitch. --repeats renders each patch N
times and takes the median (the XD render is noisy). Hardware-in-the-loop; needs the `eval`
+ `record` extras. Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

from training import audio_distance, korg, schema, xd_params
from training.eval import infer, metrics
from training.refine import detect_pitch_midi
from training.xd_interface import XdInterface

SR = schema.AUDIO["sample_rate"]
_NSYNTH = re.compile(r"_\d+-(\d+)-\d+\.wav$")  # ..._<instr>-<midi>-<velocity>.wav


def resolve_pitch(path: Path, audio: np.ndarray, args) -> int:
    m = _NSYNTH.search(path.name)
    if m:
        return int(m.group(1))
    return detect_pitch_midi(audio, SR) if args.detect_pitch else args.pitch


def expand_targets(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        out.extend(sorted(p.glob("*.wav")) if p.is_dir() else [p])
    return out


def make_scorer(target: np.ndarray, lowpass: float | None):
    """audio_distance against a fixed (optionally band-limited) target."""
    tgt = metrics.lowpass(target, lowpass) if lowpass else target

    def score(audio: np.ndarray) -> float:
        return audio_distance.distance(tgt, metrics.lowpass(audio, lowpass) if lowpass else audio)

    return score


def report(targets: list[str], results: dict[str, dict[str, float]], models: list[str]) -> None:
    w = max(len(t) for t in targets)
    head = f"{'target':<{w}}  " + "  ".join(f"{m:>10s}" for m in models)
    delta = len(models) == 2
    if delta:
        head += f"  {'Δ(2-1)':>9s}"
    print("\n=== model-comparison eval (audio_distance, lower = closer) ===")
    print(head)
    print("-" * len(head))
    for t in targets:
        row = f"{t:<{w}}  " + "  ".join(f"{results[m][t]:10.4f}" for m in models)
        if delta:
            d = results[models[1]][t] - results[models[0]][t]
            row += f"  {d:+9.4f}  {'✓' if d < 0 else '✗'}"
        print(row)
    means = {m: float(np.mean([results[m][t] for t in targets])) for m in models}
    mrow = f"{'mean':<{w}}  " + "  ".join(f"{means[m]:10.4f}" for m in models)
    if delta:
        mrow += f"  {means[models[1]] - means[models[0]]:+9.4f}"
    print("-" * len(head))
    print(mrow)
    if delta:
        a, b = models
        wins = sum(results[b][t] < results[a][t] for t in targets)
        md = means[b] - means[a]
        verdict = "IMPROVES" if md < 0 else "REGRESSES" if md > 0 else "NEUTRAL"
        print(f"\n{b} beats {a} on {wins}/{len(targets)} targets; mean Δ {md:+.4f} -> {b} {verdict}")
    else:
        best = min(means, key=means.get)
        print(f"\nbest mean: {best} ({means[best]:.4f})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--models", nargs="+", type=Path, required=True, help="ONNX checkpoints to compare")
    ap.add_argument("--targets", nargs="+", type=Path, required=True, help="target wavs (or dirs of wavs)")
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    ap.add_argument("--pitch", type=int, default=60, help="fallback render pitch when not in the filename")
    ap.add_argument("--detect-pitch", action="store_true", help="pyin-detect pitch when not in the filename")
    ap.add_argument("--lowpass", type=float, default=None, help="band-limit before scoring (8000 for 16 kHz NSynth)")
    ap.add_argument("--repeats", type=int, default=1, help="renders per patch; median (the XD render is noisy)")
    ap.add_argument("--gate", type=float, default=1.0)
    ap.add_argument("--duration", type=float, default=2.0)
    ap.add_argument("--settle", type=float, default=0.1)
    ap.add_argument("--out", type=Path, default=None, help="write results json")
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    args = ap.parse_args()

    targets = expand_targets(args.targets)
    if not targets:
        raise SystemExit("no target wavs found")
    template = korg.extract_prog_bins(args.template)[0]
    # preload each target once: audio, render pitch, scorer
    prep = []
    for t in targets:
        audio = infer.load_audio(t)
        prep.append((t, audio, resolve_pitch(t, audio, args), make_scorer(audio, args.lowpass)))

    xd = XdInterface(midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=SR)
    results: dict[str, dict[str, float]] = {}
    try:
        for model in args.models:
            session = infer.load_session(model)
            row: dict[str, float] = {}
            for t, audio, pitch, score in prep:
                prog = xd_params.write_params(template, infer.decode_raw(*infer.run_model(session, audio)))
                xd.send_patch(prog, settle_s=args.settle)
                ds = [score(xd.record(note=pitch, gate_s=args.gate, duration_s=args.duration))
                      for _ in range(args.repeats)]
                row[t.name] = float(np.median(ds))
                print(f"  {model.stem} | {t.name} @ MIDI {pitch}: {row[t.name]:.4f}")
            results[model.stem] = row
    finally:
        xd.send_patch(template, settle_s=0.05)
        xd.close()

    report([t.name for t, *_ in prep], results, [m.stem for m in args.models])
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
