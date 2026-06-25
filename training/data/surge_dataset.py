"""Surge pretraining dataset: (log-mel, Surge raw-value target).

Mels are precomputed once into a memmapped mels.npy beside the data, so every epoch reads
them instead of recomputing the STFT — training stays fast without DataLoader workers.
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

# Surge params that shape a single sustained C4 note — the focused pretrain target. (At a
# fixed pitch, keytrack barely manifests; it's kept per the chosen set but the per-param
# breakdown will reveal it as near-unlearnable.)
FOCUSED_TARGETS = [
    "a_filter_1_cutoff",
    "a_filter_1_resonance",
    "a_filter_1_keytrack",
    "a_amp_eg_attack",
    "a_amp_eg_decay",
    "a_amp_eg_sustain",
    "a_amp_eg_release",
    "a_filter_eg_attack",
    "a_filter_eg_decay",
    "a_filter_eg_sustain",
    "a_filter_eg_release",
    "a_osc_1_shape",
]


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
        if j and j % 2000 == 0:
            print(f"  {j}/{len(sample_ids)}")
    arr.flush()
    return np.load(path, mmap_mode="r")


class SurgeDataset(Dataset):
    def __init__(self, root: Path, target_names: list[str] | None = None) -> None:
        meta = json.loads((root / "meta.json").read_text())
        all_names: list[str] = meta["param_names"]
        samples = [json.loads(line) for line in (root / "samples.jsonl").open()]
        full = np.array([s["params"] for s in samples], dtype=np.float32)
        if target_names is None:
            self.param_names = all_names
            self.targets = full
        else:
            cols = [all_names.index(n) for n in target_names]
            self.param_names = list(target_names)
            self.targets = full[:, cols]
        self.mels = _ensure_mels(root, [s["id"] for s in samples])

    @property
    def n_params(self) -> int:
        return self.targets.shape[1]

    def __len__(self) -> int:
        return len(self.targets)

    def __getitem__(self, i: int) -> tuple[torch.Tensor, torch.Tensor]:
        mel = torch.from_numpy(np.array(self.mels[i], dtype=np.float32))[None]
        return mel, torch.from_numpy(self.targets[i])
