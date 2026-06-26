"""params -> CLAP-embedding proxy (Stage 2): a small MLP that approximates the
Minilogue XD + CLAP audio encoder as a single differentiable stand-in for the hardware.

Input is the flattened param vector (training/paramvec.py); output is an L2-normalized
embedding compared to the real CLAP embedding by cosine. Once trained and frozen, gradients
flow through it back to the sound-matching encoder in Stage 3, so no hardware is touched
during encoder training. Requires torch (the `train` extra).
"""

from __future__ import annotations

import torch
from torch import nn

from training import paramvec

EMBED_DIM = 512  # laion-clap audio embedding width


class ParamProxy(nn.Module):
    def __init__(self, embed_dim: int = EMBED_DIM, hidden: int = 512, depth: int = 4) -> None:
        super().__init__()
        blocks: list[nn.Module] = [nn.Linear(paramvec.VEC_DIM, hidden), nn.LayerNorm(hidden), nn.GELU()]
        for _ in range(depth - 1):
            blocks += [nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.GELU()]
        self.net = nn.Sequential(*blocks)
        self.head = nn.Linear(hidden, embed_dim)

    def forward(self, params: torch.Tensor) -> torch.Tensor:
        return torch.nn.functional.normalize(self.head(self.net(params)), dim=-1)
