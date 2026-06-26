"""Render human-made preset libraries through the XD into a labeled (audio, params) dataset
— the domain-gap mitigation: anchor the proxy + encoder in the region real targets live in,
not just the random Sobol sweep (Combes et al. 2025 show synthetic-only generalizes poorly
to hand-crafted presets).

    # factory + a third-party library, 1 note each, 20% held out for eval:
    python -m training.eval.render_presets --lib web/example-library.mnlgxdlib library.mnlgxdlib

Emits the SAME on-disk format as the Sobol sweep (training.data.xd_record), so embed.py /
sweep_dataset.py / proxy_train.py / encoder_train.py consume it unchanged:
    <out>/samples.jsonl   rows {id, source, name, split, pitch, rms, continuous, discrete, boolean}
    <out>/audio/NNNNNN.wav
    <out>/meta.json
Each preset gets a deterministic train/eval split (--eval-frac), shared across its pitches so
no preset leaks between splits; the eval split is the held-out set for measuring real-world
matching. Every preset is forced to POLY (the model only predicts POLY).

Resumable (reuses already-rendered wavs) and idempotent; rewrites samples.jsonl on a complete
pass. Run from the repo root with the XD + Volt connected; needs the record + eval extras.
"""

from __future__ import annotations

import argparse
import hashlib
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
_POLY = 4  # POLY voice mode (=4 per Korg MIDI Impl; 0 is ARP LATCH)


def _write_wav_atomic(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    tmp = path.with_suffix(".wav.tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    tmp.replace(path)  # atomic: a crashed render never leaves a half-written clip


def _preset_name(prog_bin: bytes) -> str:
    return prog_bin[4:16].decode("ascii", "replace").rstrip("\x00 ").strip()


def _is_init(name: str) -> bool:
    return (not name) or name.lower().startswith("init")


def split_of(key: str, eval_frac: float, seed: int) -> str:
    """Stable hash -> 'eval' for a fraction of presets, 'train' otherwise. Deterministic in
    (key, seed) so it survives resume and is identical across a preset's pitches."""
    h = int(hashlib.sha1(f"{seed}:{key}".encode()).hexdigest(), 16) % 1_000_000 / 1_000_000
    return "eval" if h < eval_frac else "train"


def collect_presets(libs: list[Path], include_init: bool) -> list[tuple[str, int, bytes, str]]:
    """Flatten the given .mnlgxdlib/.mnlgxdprog files (or dirs of them) into (source, slot,
    prog_bin, name), tagging each by its file stem and dropping Init blanks."""
    out: list[tuple[str, int, bytes, str]] = []
    for lib in libs:
        files = (
            sorted([*lib.glob("*.mnlgxdlib"), *lib.glob("*.mnlgxdprog")]) if lib.is_dir() else [lib]
        )
        for f in files:
            for slot, blob in enumerate(korg.extract_prog_bins(f)):
                name = _preset_name(blob)
                if include_init or not _is_init(name):
                    out.append((f.stem, slot, blob, name))
    return out


def _parse_pitches(spec: str) -> list[int]:
    return [int(p) if p.lstrip("-").isdigit() else infer.note_to_midi(p) for p in spec.split(",")]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lib", type=Path, nargs="+", default=[_REPO / "web" / "example-library.mnlgxdlib"],
                    help="one or more .mnlgxdlib/.mnlgxdprog files or dirs (factory + human libraries)")
    ap.add_argument("--out", type=Path, default=_REPO / "training" / "data" / "presets")
    ap.add_argument("--pitches", default="60", help="MIDI notes per preset (e.g. C4, or 36,60,84)")
    ap.add_argument("--eval-frac", type=float, default=0.2, help="fraction of presets held out as eval")
    ap.add_argument("--seed", type=int, default=0, help="split seed")
    ap.add_argument("--limit", type=int, help="render only the first N presets (smoke test)")
    ap.add_argument("--include-init", action="store_true", help="don't skip Init Program blanks")
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--gate", type=float, default=1.0)
    ap.add_argument("--duration", type=float, default=2.0)
    ap.add_argument("--settle", type=float, default=0.1)
    ap.add_argument("--recal", type=int, default=50, help="recalibrate every N presets")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    pitches = _parse_pitches(args.pitches)
    sr = schema.AUDIO["sample_rate"]
    audio_dir = args.out / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    presets = collect_presets(args.lib, args.include_init)
    if args.limit:
        presets = presets[: args.limit]
    n_eval = sum(split_of(f"{s}:{slot}", args.eval_frac, args.seed) == "eval" for s, slot, _, _ in presets)
    print(f"{len(presets)} presets from {len(args.lib)} source(s) × {len(pitches)} pitch(es) "
          f"= {len(presets) * len(pitches)} clips; {n_eval} presets held out as eval")

    template = korg.extract_prog_bins(infer.DEFAULT_TEMPLATE)[0]
    xd = XdInterface(midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=sr)

    def calibrate() -> float:
        xd.send_patch(template, settle_s=args.settle)
        return float(np.sqrt(np.mean(xd.record(note=60, gate_s=args.gate, duration_s=args.duration) ** 2)))

    rows: list[dict] = []
    silent = 0
    p = len(pitches)
    try:
        cal = calibrate()
        print(f"calibration rms={cal:.4f}")
        if cal < RMS_FLOOR:
            raise RuntimeError("calibration silent — check XD power/volume + Volt input gain")

        with keep_awake():
            for pi, (source, slot, prog_bin, name) in enumerate(presets):
                raw = xd_params.read_params(prog_bin)
                raw["voice_mode"] = _POLY
                split = split_of(f"{source}:{slot}", args.eval_frac, args.seed)
                targets = xd_params.targets_for(raw)
                paths = [audio_dir / f"{pi * p + j:06d}.wav" for j in range(p)]
                if not all(w.exists() for w in paths):  # (re)load patch only when a render is due
                    # Write the preset's params onto the CLEAN template (as the sweep does), not
                    # the preset's own prog_bin: any stored sequencer/arp/latch lives outside our
                    # 52-param schema, so starting from the preset would keep it and the held note
                    # would arpeggiate — ruining the single-sustained-note clip.
                    xd.send_patch(xd_params.write_params(template, raw), settle_s=args.settle)
                for j, midi in enumerate(pitches):
                    gid, wav = pi * p + j, paths[j]
                    if wav.exists():
                        rms = float(np.sqrt(np.mean(infer.load_audio(wav) ** 2)))
                    else:
                        clip = xd.record(note=midi, gate_s=args.gate, duration_s=args.duration)
                        rms = float(np.sqrt(np.mean(clip**2)))
                        if rms < RMS_FLOOR:
                            silent += 1
                            continue
                        _write_wav_atomic(wav, clip, sr)
                    rows.append({"id": gid, "source": source, "name": name, "split": split,
                                 "pitch": midi, "rms": round(rms, 5), **targets})
                if (pi + 1) % args.recal == 0:
                    drift = calibrate()
                    print(f"  [{pi + 1}/{len(presets)}] recal rms={drift:.4f}")
                    if drift < RMS_FLOOR:
                        raise RuntimeError("calibration went silent mid-run — aborting")
    finally:
        try:
            xd.send_patch(template, settle_s=0.05)
        finally:
            xd.close()

    rows.sort(key=lambda r: r["id"])
    tmp = args.out / "samples.jsonl.tmp"
    tmp.write_text("\n".join(json.dumps(r) for r in rows) + ("\n" if rows else ""))
    tmp.replace(args.out / "samples.jsonl")
    (args.out / "meta.json").write_text(json.dumps({
        "continuous": [p_["id"] for p_ in schema.CONTINUOUS],
        "discrete": [{"id": p_["id"], "cardinality": p_["cardinality"]} for p_ in schema.DISCRETE],
        "boolean": [p_["id"] for p_ in schema.BOOLEAN],
        "sample_rate": sr, "gate_s": args.gate, "duration_s": args.duration, "pitches": pitches,
        "sources": [str(x) for x in args.lib], "eval_frac": args.eval_frac, "seed": args.seed,
        "origin": "render_presets",
    }))
    n_tr = sum(r["split"] == "train" for r in rows)
    print(f"wrote {len(rows)} clips ({n_tr} train / {len(rows) - n_tr} eval, {silent} silent dropped) "
          f"to {args.out / 'samples.jsonl'}")


if __name__ == "__main__":
    main()
