"""Stage 4 — hardware refinement (CMA-ES as last-mile corrector). The encoder gives a good
initial patch; CMA-ES then searches a small neighborhood of it *on the real XD* to correct
proxy/encoder error the gradient pipeline couldn't see.

    python -m training.refine --target sound.wav --out match.mnlgxdprog
    python -m training.refine --smoke     # no hardware/cma-on-hardware: prove the CMA-ES loop

1. encoder estimate (web/public/models/model.onnx) -> raw params
2. render on the XD, record, score log-mel-L1 vs target (eval.metrics, the encoder's space)
3. if that exceeds --threshold, CMA-ES over the *continuous* params only (the smooth ones:
   cutoff, EG times, levels…), holding the discrete heads (waves/filter type) fixed — those
   are categorical and the encoder picks them outright. Each candidate is a hardware render.
4. optionally stash the best (params, audio) into --accumulate for later proxy improvement.

Hardware renders dominate the cost, so the budget is --evals (objective calls). Needs the
`eval` extra (librosa + onnxruntime), the `record` extra (XD I/O), and `refine` (cma).
Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.eval import infer, metrics
from training.xd_interface import XdInterface

CONTINUOUS = schema.CONTINUOUS


def to_continuous_unit(raw: dict[str, int]) -> np.ndarray:
    return np.array([raw[p["id"]] / p["raw_max"] for p in CONTINUOUS], dtype=np.float64)


def apply_continuous(base_raw: dict[str, int], x) -> dict[str, int]:
    """Overlay a continuous unit-vector onto the fixed (discrete/boolean) base estimate."""
    raw = dict(base_raw)
    for p, xi in zip(CONTINUOUS, x):
        raw[p["id"]] = int(min(p["raw_max"], max(0, round(float(xi) * p["raw_max"]))))
    return raw


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _accumulate(out: Path, raw: dict[str, int], audio: np.ndarray, sr: int) -> None:
    (out / "audio").mkdir(parents=True, exist_ok=True)
    manifest = out / "samples.jsonl"
    idx = sum(1 for _ in manifest.open()) if manifest.exists() else 0
    _write_wav(out / "audio" / f"{idx:06d}.wav", audio, sr)
    with manifest.open("a") as f:
        f.write(json.dumps({"id": idx, "source": "refine", **xd_params.targets_for(raw)}) + "\n")


def refine(target, session, template, render, *, threshold, evals, sigma, seed):
    """render(raw) -> recorded audio. Returns (best_raw, best_distance, best_audio)."""
    base_raw = infer.decode_raw(*infer.run_model(session, target))

    def score(audio) -> float:
        return metrics.compare(target, audio)["mel_l1"]

    best_audio = render(base_raw)
    best_d = score(best_audio)
    best_raw = base_raw
    print(f"encoder estimate: mel_l1={best_d:.4f}")
    if best_d <= threshold:
        print("within threshold — skipping CMA-ES")
        return best_raw, best_d, best_audio

    import cma  # the `refine` extra

    es = cma.CMAEvolutionStrategy(
        to_continuous_unit(base_raw).tolist(),
        sigma,
        {"bounds": [0.0, 1.0], "maxfevals": evals, "seed": seed, "verbose": -9},
    )
    done = 0
    while not es.stop():
        candidates = es.ask()
        losses = []
        for x in candidates:
            raw = apply_continuous(base_raw, x)
            audio = render(raw)
            d = score(audio)
            losses.append(d)
            done += 1
            if d < best_d:
                best_d, best_raw, best_audio = d, raw, audio
        es.tell(candidates, losses)
        print(f"  evals {done}: best mel_l1={best_d:.4f}")
    print(f"CMA-ES refined mel_l1 {score(render(base_raw)):.4f} -> {best_d:.4f}")
    return best_raw, best_d, best_audio


def _smoke(args) -> None:
    import cma

    rng = np.random.default_rng(args.seed)
    target = rng.random(len(CONTINUOUS))  # the hidden best continuous vector
    x0 = np.clip(target + 0.25 * rng.standard_normal(len(CONTINUOUS)), 0.0, 1.0)
    obj = lambda x: float(np.mean((np.asarray(x) - target) ** 2))
    es = cma.CMAEvolutionStrategy(
        x0.tolist(), 0.2, {"bounds": [0.0, 1.0], "maxfevals": 3000, "seed": args.seed + 1, "verbose": -9}
    )
    while not es.stop():
        xs = es.ask()
        es.tell(xs, [obj(x) for x in xs])
    print(f"smoke CMA-ES: start {obj(x0):.4f} -> best {es.result.fbest:.6f} over {len(CONTINUOUS)} dims")
    assert es.result.fbest < 1e-3, f"smoke: CMA-ES did not converge ({es.result.fbest})"
    print("OK: CMA-ES neighborhood search converges")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", type=Path, help="target sound (wav) to match")
    ap.add_argument("--out", type=Path, help=".mnlgxdprog to write the refined patch")
    ap.add_argument("--model", type=Path, default=infer.DEFAULT_MODEL)
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    ap.add_argument("--pitch", type=int, default=60, help="MIDI note to render the candidate patch")
    ap.add_argument("--gate", type=float, default=1.0)
    ap.add_argument("--duration", type=float, default=2.0)
    ap.add_argument("--settle", type=float, default=0.1)
    ap.add_argument("--threshold", type=float, default=0.0, help="skip CMA-ES if estimate mel_l1 <= this (0 = always refine)")
    ap.add_argument("--evals", type=int, default=140, help="CMA-ES objective calls (hardware renders)")
    ap.add_argument("--sigma", type=float, default=0.1, help="CMA-ES initial step (neighborhood width in [0,1])")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--accumulate", type=Path, default=None, help="dir to stash (params, audio) for proxy improvement")
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--smoke", action="store_true", help="synthetic CMA-ES convergence check (no hardware)")
    args = ap.parse_args()

    if args.smoke:
        _smoke(args)
        return
    if not args.target or not args.out:
        raise SystemExit("--target and --out are required (or use --smoke)")

    sr = schema.AUDIO["sample_rate"]
    session = infer.load_session(args.model)
    template = korg.extract_prog_bins(args.template)[0]
    target = infer.load_audio(args.target)
    xd = XdInterface(midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=sr)
    try:
        def render(raw: dict[str, int]) -> np.ndarray:
            xd.send_patch(xd_params.write_params(template, raw), settle_s=args.settle)
            return xd.record(note=args.pitch, gate_s=args.gate, duration_s=args.duration)

        best_raw, best_d, best_audio = refine(
            target, session, template, render,
            threshold=args.threshold, evals=args.evals, sigma=args.sigma, seed=args.seed,
        )
        korg.write_mnlgxdprog(args.template, xd_params.write_params(template, best_raw), args.out)
        print(f"wrote {args.out} (mel_l1={best_d:.4f})")
        if args.accumulate:
            _accumulate(args.accumulate, best_raw, best_audio, sr)
            print(f"stashed refined sample -> {args.accumulate}")
    finally:
        xd.send_patch(template, settle_s=0.05)
        xd.close()


if __name__ == "__main__":
    main()
