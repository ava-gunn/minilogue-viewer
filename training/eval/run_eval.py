"""Real-world resynthesis eval loop. For each pitch-labeled clip in a manifest: predict an
XD program from the audio, realize it on the hardware at that clip's pitch (or score
pre-recorded renders), and compare to the original with the model's own log-mel (+ MFCC /
multi-scale STFT). Writes per-clip programs and a per-cohort / per-pitch report.

    # build a set first (training.eval.build_eval_set), then one of:

    # automated — XD + audio interface connected; pip install -e '.[eval,record]'
    python -m training.eval.run_eval --manifest eval/set/manifest.jsonl --out eval/set --hardware

    # score renders captured by hand (load eval/set/programs/<id>.mnlgxdprog, play the clip's
    # pitch, save <dir>/<id>.wav)
    python -m training.eval.run_eval --manifest eval/set/manifest.jsonl --out eval/set --recordings ~/renders

    # just write the programs to load manually
    python -m training.eval.run_eval --manifest eval/set/manifest.jsonl --out eval/set --predict-only

NSynth is 16 kHz — pass --lowpass 8000 so the full-band XD recording is band-limited to
match before scoring. Run from the repo root.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import statistics
import wave
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.eval import infer, metrics

SR = schema.AUDIO["sample_rate"]
RMS_FLOOR = 1e-3


def _write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


@contextlib.contextmanager
def _nullctx():
    yield


def _aggregate(results: list[dict], by: str) -> dict:
    keys = [k for k in results[0] if k not in ("id", "cohort", "pitch")]
    groups: dict = {}
    for r in results:
        groups.setdefault(r[by], []).append(r)
    return {
        g: {"n": len(rs), **{k: statistics.median(r[k] for r in rs) for k in keys}}
        for g, rs in sorted(groups.items())
    }, keys


def _param_metrics(pred: dict[str, int], true: dict) -> dict:
    """Predicted vs ground-truth raw params (only for cohorts that carry true_raw, i.e.
    factory presets): mean continuous L1 in [0,1] space, discrete/boolean exact-match rate."""
    cont = [
        abs(pred[p["id"]] / p["raw_max"] - int(true[p["id"]]) / p["raw_max"])
        for p in schema.CONTINUOUS
        if p["id"] in true and p["id"] in pred
    ]
    disc = [pred[p["id"]] == int(true[p["id"]]) for p in schema.DISCRETE if p["id"] in true]
    boo = [pred[p["id"]] == int(true[p["id"]]) for p in schema.BOOLEAN if p["id"] in true]
    return {
        "cont_l1": float(np.mean(cont)) if cont else 0.0,
        "disc_acc": float(np.mean(disc)) if disc else 0.0,
        "bool_acc": float(np.mean(boo)) if boo else 0.0,
    }


def _report_params(out: Path, results: list[dict]) -> None:
    """Param-space accuracy table — only presets have known ground truth, so this is the
    metric the factory cohort adds over the audio-only resynthesis distance."""
    agg, keys = _aggregate(results, "cohort")
    print(f"\n{'param-acc':12} {'n':>4} " + " ".join(f"{k:>9}" for k in keys))
    for g, row in agg.items():
        print(f"{str(g):12} {row['n']:>4} " + " ".join(f"{row[k]:>9.3f}" for k in keys))
    rep = json.loads((out / "report.json").read_text())
    rep["param_by_cohort"], rep["param_per_clip"] = agg, results
    (out / "report.json").write_text(json.dumps(rep, indent=2))
    print("param-acc: cont_l1 lower=better; disc_acc/bool_acc higher=better")


def _report(out: Path, results: list[dict]) -> None:
    if not results:
        print("no scored pairs — nothing to report")
        return
    by_cohort, keys = _aggregate(results, "cohort")
    by_pitch, _ = _aggregate(results, "pitch")

    def table(title: str, agg: dict) -> None:
        print(f"\n{title:12} {'n':>4} " + " ".join(f"{k:>9}" for k in keys))
        for g, row in agg.items():
            print(f"{str(g):12} {row['n']:>4} " + " ".join(f"{row[k]:>9.3f}" for k in keys))

    table("cohort", by_cohort)
    table("pitch", by_pitch)
    (out / "report.json").write_text(
        json.dumps({"per_clip": results, "by_cohort": by_cohort, "by_pitch": by_pitch}, indent=2)
    )
    print(f"\nwrote {out / 'report.json'} — lower is closer; mel_l1 is the model-space metric")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--model", type=Path, default=infer.DEFAULT_MODEL)
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--hardware", action="store_true", help="send each program to the XD and record")
    mode.add_argument("--recordings", type=Path, help="dir of pre-recorded <id>.wav renders to score")
    mode.add_argument("--predict-only", action="store_true", help="write programs only; don't score")
    ap.add_argument("--lowpass", type=float, help="low-pass both signals to N Hz before scoring (8000 for NSynth)")
    ap.add_argument("--limit", type=int)
    # hardware options (mirror training/data/xd_record.py)
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--gate", type=float, default=0.6)
    ap.add_argument("--settle", type=float, default=0.1)
    args = ap.parse_args()

    rows = [json.loads(line) for line in args.manifest.read_text().splitlines() if line.strip()]
    if args.limit:
        rows = rows[: args.limit]
    (args.out / "programs").mkdir(parents=True, exist_ok=True)
    (args.out / "xd").mkdir(parents=True, exist_ok=True)

    session = infer.load_session(args.model)
    template = korg.extract_prog_bins(args.template)[0]

    xd = None
    ctx = _nullctx()
    if args.hardware:
        from training.runtime import keep_awake
        from training.xd_interface import XdInterface

        xd = XdInterface(
            midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=SR
        )
        xd.send_patch(template, settle_s=args.settle)
        cal = xd.record(note=60, gate_s=args.gate, duration_s=schema.AUDIO["duration_s"])
        cal_rms = float(np.sqrt(np.mean(cal**2)))
        print(f"calibration rms={cal_rms:.4f}")
        if cal_rms < RMS_FLOOR:
            xd.close()
            raise RuntimeError("calibration silent — check XD power/volume + audio input gain")
        ctx = keep_awake()

    results: list[dict] = []
    param_results: list[dict] = []
    try:
        with ctx:
            for r in rows:
                rid, midi = r["id"], int(r.get("pitch_midi", 60))
                signal = infer.load_audio(Path(r["source_path"]))
                cont, disc, boo = infer.run_model(session, signal)
                raw_pred = infer.decode_raw(cont, disc, boo)
                prog_bin = xd_params.write_params(template, raw_pred)
                (args.out / "programs" / f"{rid}.prog_bin").write_bytes(prog_bin)
                korg.write_mnlgxdprog(
                    args.template, prog_bin, args.out / "programs" / f"{rid}.mnlgxdprog"
                )
                if args.predict_only:
                    continue

                if args.hardware:
                    xd.send_patch(prog_bin, settle_s=args.settle)
                    xd_audio = xd.record(
                        note=midi, gate_s=args.gate, duration_s=schema.AUDIO["duration_s"]
                    )
                    _write_wav(args.out / "xd" / f"{rid}.wav", xd_audio)
                else:  # --recordings
                    wav = args.recordings / f"{rid}.wav"
                    if not wav.exists():
                        print(f"skip {rid}: no recording at {wav}")
                        continue
                    xd_audio = infer.load_audio(wav)

                m = metrics.compare(signal, xd_audio, lowpass_hz=args.lowpass)
                results.append({"id": rid, "cohort": r.get("cohort", "?"), "pitch": midi, **m})
                if r.get("true_raw"):  # presets carry ground-truth params -> param accuracy
                    param_results.append(
                        {
                            "id": rid,
                            "cohort": r.get("cohort", "?"),
                            "pitch": midi,
                            **_param_metrics(raw_pred, r["true_raw"]),
                        }
                    )
                print(f"{rid} [{r.get('cohort')} m{midi}] mel_l1={m['mel_l1']:.3f}")
    finally:
        if xd is not None:
            xd.send_patch(template, settle_s=0.05)  # leave a benign patch (no self-oscillation)
            xd.close()

    if args.predict_only:
        print(
            f"wrote {len(rows)} programs to {args.out / 'programs'} — load each on the XD, "
            f"play the clip's pitch, save <id>.wav, then rerun with --recordings <dir>"
        )
        return
    _report(args.out, results)
    if param_results:
        _report_params(args.out, param_results)


if __name__ == "__main__":
    main()
