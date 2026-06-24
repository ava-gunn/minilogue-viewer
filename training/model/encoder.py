"""Compact CNN encoder: log-mel spectrogram -> multi-head parameter estimate.

Heads are sized from the shared schema so they can't drift from the app. Outputs are
in raw parameter space: continuous in [0,1] (sigmoid), discrete as concatenated logits
(argmax per group at decode time), boolean in [0,1] (sigmoid).

Requires torch (the `train` extra); not imported by `export.py --dummy`.
"""

from __future__ import annotations

import torch
from torch import nn

from training import schema


class SoundMatchEncoder(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1),
            nn.BatchNorm2d(16),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.trunk = nn.Sequential(nn.Flatten(), nn.Linear(64, 128), nn.ReLU())
        self.continuous = nn.Linear(128, schema.N_CONTINUOUS)
        self.discrete = nn.Linear(128, schema.TOTAL_DISCRETE)
        self.boolean = nn.Linear(128, schema.N_BOOLEAN)

    def forward(self, mel: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        h = self.trunk(self.features(mel))
        return (
            torch.sigmoid(self.continuous(h)),
            self.discrete(h),
            torch.sigmoid(self.boolean(h)),
        )
