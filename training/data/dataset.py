"""Datasets for training, all yielding the same (mel, continuous, discrete, boolean)
contract the train loop + loss expect:

  mel        : float32 [1, N_MELS, N_FRAMES]      (DataLoader batches to [B,1,...])
  continuous : float32 [n_continuous] in [0,1]
  discrete   : int64   [n_discrete]   class indices
  boolean    : float32 [n_boolean]    in {0,1}

SyntheticDataset exists to exercise the train loop before real data lands (Phase 4). The
Surge XT sampler (4a) and the XD recordings (4b) will implement the same contract.
"""

from __future__ import annotations

import torch
from torch.utils.data import Dataset

from training import schema

Item = tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]


def _random_targets(g: torch.Generator) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    continuous = torch.rand(schema.N_CONTINUOUS, generator=g)
    discrete = torch.tensor(
        [
            int(torch.randint(0, card, (1,), generator=g).item())
            for card in schema.DISCRETE_CARDINALITIES
        ],
        dtype=torch.long,
    )
    boolean = (torch.rand(schema.N_BOOLEAN, generator=g) > 0.5).float()
    return continuous, discrete, boolean


class SyntheticDataset(Dataset[Item]):
    """A small fixed random dataset. Targets are arbitrary, but it's small enough that
    the model can overfit — so a smoke run shows the loss actually going down, proving
    the forward/loss/backward path works end to end."""

    def __init__(self, n: int = 64, seed: int = 0) -> None:
        g = torch.Generator().manual_seed(seed)
        self._items: list[Item] = []
        for _ in range(n):
            mel = torch.randn(1, schema.N_MELS, schema.N_FRAMES, generator=g)
            self._items.append((mel, *_random_targets(g)))

    def __len__(self) -> int:
        return len(self._items)

    def __getitem__(self, index: int) -> Item:
        return self._items[index]
