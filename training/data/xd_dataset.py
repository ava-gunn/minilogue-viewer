"""XD fine-tune dataset: (log-mel, multi-head targets) from real recordings.

Yields (mel, continuous, discrete, boolean) matching the model heads + multihead_loss:
continuous float [0,1], discrete int64 class indices, boolean float {0,1}. Mels are
precomputed into a memmapped mels.npy beside the data (same as the Surge dataset).
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from training import schema
from training.data import mel as melmod


def _read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def _ensure_mels(root: Path, sample_ids: list[int]) -> np.ndarray:
    path = root / "mels.npy"
    shape = (len(sample_ids), schema.N_MELS, schema.N_FRAMES)
    if path.exists():
        arr = np.load(path, mmap_mode="r")
        if arr.shape == shape:
            return arr
    print(f"precomputing {len(sample_ids)} mels -> {path}")
    arr = np.lib.format.open_memmap(path, mode="w+", dtype=np.float32, shape=shape)
    for j, sid in enumerate(sample_ids):
        arr[j] = melmod.log_mel(_read_wav(root / "audio" / f"{sid:06d}.wav"))
        if j and j % 1000 == 0:
            print(f"  {j}/{len(sample_ids)}")
    arr.flush()
    return np.load(path, mmap_mode="r")


class XdDataset(Dataset):
    def __init__(self, root: Path) -> None:
        samples = [json.loads(line) for line in (root / "samples.jsonl").open()]
        self.continuous = np.array([s["continuous"] for s in samples], dtype=np.float32)
        self.discrete = np.array([s["discrete"] for s in samples], dtype=np.int64)
        self.boolean = np.array([s["boolean"] for s in samples], dtype=np.float32)
        self.mels = _ensure_mels(root, [s["id"] for s in samples])

    def __len__(self) -> int:
        return len(self.continuous)

    def __getitem__(self, i: int):
        mel = torch.from_numpy(np.array(self.mels[i], dtype=np.float32))[None]
        return (
            mel,
            torch.from_numpy(self.continuous[i]),
            torch.from_numpy(self.discrete[i]),
            torch.from_numpy(self.boolean[i]),
        )
