"""Surge XT pretraining-data sampler, restricted to the Surge params that most closely
match the Korg Minilogue XD's controls.

The XD is a fixed-architecture subtractive analog (Classic-style oscillators, a 2-pole LP
filter, two ADSR EGs). So we FIX Surge's structural params to that architecture (osc
engine = Classic, filter = LP 12 dB) and randomize only the continuous controls the XD
actually exposes — keeping renders in the XD's sonic territory and the learned features
transferable. The stored target is the randomized Surge raw_values (a Surge-native head,
discarded when fine-tuning on the XD head); the manifest records the param names.

    python -m training.data.surge_sampler --n 1000 --out training/data/surge

Requires the `surge` extra (pedalboard) + Surge XT VST3 installed. Run from the repo root.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import wave
from pathlib import Path

import mido
import numpy as np
from pedalboard import load_plugin

from training import schema

C4 = 60
RMS_FLOOR = 1e-3  # discard renders quieter than this (e.g. amp EG decayed to silence)
# Gate the note off well before the render ends so the amp/filter envelope — including
# the release tail — is captured in the audio (not just a held sustain).
NOTE_GATE_S = 0.6

# Structural params fixed to the XD's architecture (set once per render, not randomized).
_FIXED = {
    "a_osc_1_type": "Classic",
    "a_osc_2_type": "Classic",
    "a_osc_3_type": "Classic",
    "a_filter_1_type": "LP 12 dB",  # 2-pole LP, closest to the XD filter
    "a_filter_2_type": "Off",
}

# Continuous Surge params analogous to the XD's controls — the randomized target vector,
# grouped by XD counterpart. (LFO and portamento are omitted: an LFO needs an explicit mod
# routing to be audible, and portamento has no effect on a single sustained note.)
_MATCHED = [
    # VCO 1 — XD wave/shape ≈ Classic osc shape + pulse width
    "a_osc_1_shape", "a_osc_1_width_1", "a_osc_1_pitch", "a_osc_1_octave",
    "a_osc_1_volume", "a_osc_1_sub_mix",
    # VCO 2 (+ sync, ring)
    "a_osc_2_shape", "a_osc_2_width_1", "a_osc_2_pitch", "a_osc_2_octave",
    "a_osc_2_volume", "a_osc_2_sub_mix", "a_osc_2_sync",
    "a_ring_modulation_1x2_volume",
    # MULTI ≈ osc 3 + noise
    "a_osc_3_shape", "a_osc_3_pitch", "a_osc_3_octave", "a_osc_3_volume",
    "a_noise_volume", "a_noise_color",
    # FILTER
    "a_filter_1_cutoff", "a_filter_1_resonance", "a_filter_1_keytrack",
    "a_filter_1_feg_mod_amount",
    # AMP EG
    "a_amp_eg_attack", "a_amp_eg_decay", "a_amp_eg_sustain", "a_amp_eg_release",
    # FILTER EG
    "a_filter_eg_attack", "a_filter_eg_decay", "a_filter_eg_sustain",
    "a_filter_eg_release",
    # VOICE
    "a_octave",
]


def find_surge() -> str:
    for pattern in (
        "/Library/Audio/Plug-Ins/VST3/*urge*.vst3",
        os.path.expanduser("~/Library/Audio/Plug-Ins/VST3/*urge*.vst3"),
    ):
        hits = glob.glob(pattern)
        if hits:
            return hits[0]
    raise FileNotFoundError("Surge XT VST3 not found in the default VST3 locations")


def _set_discrete(param, label: str) -> None:
    try:
        param.raw_value = param.get_raw_value_for(label)
    except Exception:
        values = list(param.valid_values)
        if label in values:  # else leave the param default rather than abort the whole run
            param.raw_value = values.index(label) / max(len(values) - 1, 1)
        else:
            print(f"warning: {label!r} invalid for this param; left at default")


def matched_params(instrument) -> list[str]:
    present = instrument.parameters
    return [name for name in _MATCHED if name in present]


def _render_c4(instrument, duration: float, sr: int) -> np.ndarray:
    midi = [
        mido.Message("note_on", note=C4, velocity=100, time=0.0),
        mido.Message("note_off", note=C4, time=min(NOTE_GATE_S, duration)),
    ]
    stereo = instrument(midi, duration=duration, sample_rate=sr)  # (2, N) float32
    return stereo.mean(axis=0)


def sample_once(instrument, names: list[str], rng: np.random.Generator):
    params = instrument.parameters
    for name, label in _FIXED.items():
        if name in params:
            _set_discrete(params[name], label)

    # Re-fetch each step: setting a structural param can change which params are available.
    vec = np.zeros(len(names), dtype=np.float32)
    for i, name in enumerate(names):
        params = instrument.parameters
        if name not in params:
            continue
        params[name].raw_value = float(rng.random())
        vec[i] = params[name].raw_value  # read back the (quantized) value

    n = schema.N_SAMPLES
    audio = _render_c4(instrument, schema.AUDIO["duration_s"], schema.AUDIO["sample_rate"])
    if audio.shape[0] < n:
        audio = np.pad(audio, (0, n - audio.shape[0]))
    return audio[:n].astype(np.float32), vec


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _count_done(out: Path) -> int:
    jsonl = out / "samples.jsonl"
    if not jsonl.exists():
        return 0
    with jsonl.open() as f:
        return sum(1 for _ in f)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=100, help="total target sample count")
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "training" / "data" / "surge",
    )
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    instrument = load_plugin(find_surge())
    names = matched_params(instrument)
    sr = schema.AUDIO["sample_rate"]
    audio_dir = args.out / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    (args.out / "meta.json").write_text(
        json.dumps(
            {
                "param_names": names,
                "fixed": _FIXED,
                "sample_rate": sr,
                "duration_s": schema.AUDIO["duration_s"],
            }
        )
    )

    # Resume: samples.jsonl is appended + flushed per sample, so a crash/stop loses
    # nothing. We continue from however many are already on disk.
    start = _count_done(args.out)
    if start >= args.n:
        print(f"already have {start} >= {args.n} samples at {args.out}; nothing to do")
        return
    print(f"{len(names)} XD-matched params | resuming at {start}, target {args.n}")

    rng = np.random.default_rng(args.seed + start)
    kept, attempts = start, 0
    with (args.out / "samples.jsonl").open("a") as manifest:
        while kept < args.n:
            attempts += 1
            audio, vec = sample_once(instrument, names, rng)
            rms = float(np.sqrt(np.mean(audio**2)))
            if rms < RMS_FLOOR:
                continue
            _write_wav(audio_dir / f"{kept:06d}.wav", audio, sr)
            manifest.write(
                json.dumps({"id": kept, "rms": rms, "params": vec.tolist()}) + "\n"
            )
            manifest.flush()
            kept += 1
            if kept % 100 == 0:
                print(f"{kept}/{args.n} ({attempts} attempts this run)")

    print(f"done: {kept} samples at {args.out} ({attempts} attempts this run)")


if __name__ == "__main__":
    main()
