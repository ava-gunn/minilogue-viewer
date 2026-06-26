"""Load a sweep dir for end-to-end encoder training (Stage 3): pair each clip's encoder
input (log-mel of its first second) with its CLAP embedding target and its true param
vector (for the optional auxiliary loss).

Mels are precomputed once into mels.npy (memmap, marked by mels.done); reused on the next
run. The encoder only ever sees the first N_SAMPLES (1 s) — the ONNX input contract — while
the embedding target was computed from the full 2 s clip (tail included).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training import paramvec, schema
from training.data import mel as mel_mod
from training.data.embed import read_wav


def _precompute_mels(data_dir: Path, rows: list[dict]) -> np.ndarray:
    path = data_dir / "mels.npy"
    done = data_dir / "mels.done"
    shape = (len(rows), schema.N_MELS, schema.N_FRAMES)
    if path.exists() and done.exists() and tuple(np.load(path, mmap_mode="r").shape) == shape:
        return np.load(path, mmap_mode="r")
    done.unlink(missing_ok=True)
    mels = np.lib.format.open_memmap(path, mode="w+", dtype=np.float32, shape=shape)
    for i, r in enumerate(rows):
        audio, _ = read_wav(data_dir / "audio" / f"{r['id']:06d}.wav")
        mels[i] = mel_mod.log_mel(audio[: schema.N_SAMPLES])
        if (i + 1) % 500 == 0:
            print(f"mel {i + 1}/{len(rows)}")
    mels.flush()
    done.touch()
    return mels


def load_sweep(data_dir: Path) -> tuple[np.ndarray, torch.Tensor, torch.Tensor]:
    """Returns (mels [N, N_MELS, N_FRAMES] memmap, embeddings [N, E] unit-norm,
    param vectors [N, VEC_DIM]), all row-aligned to clip id."""
    rows = [json.loads(line) for line in (data_dir / "samples.jsonl").read_text().splitlines()]
    emb = np.asarray(np.load(data_dir / "embeddings.npy", mmap_mode="r"), dtype=np.float32)
    if len(emb) != len(rows):
        raise SystemExit(f"samples/embeddings mismatch: {len(rows)} rows vs {len(emb)} embeddings")
    mels = _precompute_mels(data_dir, rows)
    params = np.stack([paramvec.targets_to_vector(r) for r in rows])
    return mels, F.normalize(torch.from_numpy(emb), dim=-1), torch.from_numpy(params)
