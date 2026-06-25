"""Audio -> model -> Minilogue XD program, mirroring the browser inference path
(web/src/inference): decode/resample/mono/fit -> log-mel [1,1,N_MELS,N_FRAMES] -> ONNX ->
decode heads -> raw params -> prog_bin. Forces voice_mode=POLY (a single sustained note).

The model takes ONE note's mel. Multi-pitch training (capturing each patch at C2/C4/C6) is
data augmentation that sharpens keytrack/octave — it does not change the single-note input.
So eval clips need only be single, pitch-labeled notes (any pitch); run_eval plays the XD
at each clip's own pitch and compares.

    python -m training.eval.infer --audio note.wav --out note.mnlgxdprog

Run from the repo root. Needs the `eval` extra (librosa) + web/public/models/model.onnx.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.data.mel import log_mel

_REPO = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = _REPO / "web" / "public" / "models" / "model.onnx"
DEFAULT_TEMPLATE = _REPO / "web" / "replicant-example.mnlgxdprog"

SR = schema.AUDIO["sample_rate"]

_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_to_midi(name: str) -> int:
    """'C4' -> 60, 'C2' -> 36, 'F#3' -> 54 (C4 == 60 convention)."""
    name = name.strip()
    semi = _SEMITONE[name[0].upper()]
    i = 1
    if i < len(name) and name[i] in "#b":
        semi += 1 if name[i] == "#" else -1
        i += 1
    return (int(name[i:]) + 1) * 12 + semi


# Pitches the model trained on, for the default eval pitch filter (names; MIDI alongside).
# Falls back to the legacy single "pitch" field.
TRAIN_PITCHES: list[str] = schema.AUDIO.get("pitches") or [schema.AUDIO.get("pitch", "C4")]
TRAIN_PITCH_MIDIS: list[int] = [note_to_midi(p) for p in TRAIN_PITCHES]


def fit(signal: np.ndarray, n: int = schema.N_SAMPLES) -> np.ndarray:
    """Crop/zero-pad to exactly n samples from the onset (the model's fixed input length)."""
    signal = np.asarray(signal, dtype=np.float32)
    if len(signal) >= n:
        return signal[:n]
    out = np.zeros(n, dtype=np.float32)
    out[: len(signal)] = signal
    return out


def load_audio(path: Path) -> np.ndarray:
    """Load a clip as the model's input: resample to SR, downmix to mono, crop/pad to
    N_SAMPLES. No amplitude normalization — matches decodeToSamples in audio.ts."""
    import librosa

    y, _ = librosa.load(str(path), sr=SR, mono=True)
    return fit(y)


def load_session(model: Path = DEFAULT_MODEL):
    import onnxruntime as ort

    return ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])


def run_model(session, signal: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mel = log_mel(fit(signal)).reshape(schema.INPUT_SHAPE).astype(np.float32)
    cont, disc, boo = session.run(list(schema.OUTPUT_NAMES), {schema.INPUT_NAME: mel})
    return cont[0], disc[0], boo[0]


def decode_raw(
    cont: np.ndarray, disc: np.ndarray, boo: np.ndarray, *, force_poly: bool = True
) -> dict[str, int]:
    """Model head outputs -> raw param values by id. Mirrors web/src/inference/decode.ts:
    continuous = round(sigmoid * raw_max) clamped, discrete = argmax per logit group,
    boolean = (sigmoid >= 0.5)."""
    raw: dict[str, int] = {}
    for p, v in zip(schema.CONTINUOUS, cont):
        raw[p["id"]] = int(min(p["raw_max"], max(0, round(float(v) * p["raw_max"]))))
    offset = 0
    for p in schema.DISCRETE:
        c = p["cardinality"]
        raw[p["id"]] = int(np.argmax(disc[offset : offset + c]))
        offset += c
    for p, v in zip(schema.BOOLEAN, boo):
        raw[p["id"]] = 1 if float(v) >= 0.5 else 0
    if force_poly:
        raw["voice_mode"] = 0  # POLY: a single sustained note, never ARP/CHORD/UNISON
    return raw


def predict_prog_bin(
    session, signal: np.ndarray, template: bytes, *, force_poly: bool = True
) -> bytes:
    cont, disc, boo = run_model(session, signal)
    return xd_params.write_params(template, decode_raw(cont, disc, boo, force_poly=force_poly))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True, help=".mnlgxdprog to write")
    ap.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    ap.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    args = ap.parse_args()

    session = load_session(args.model)
    template = korg.extract_prog_bins(args.template)[0]
    prog_bin = predict_prog_bin(session, load_audio(args.audio), template)
    korg.write_mnlgxdprog(args.template, prog_bin, args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
