"""Compact CNN for sound matching, split so the feature extractor transfers across synths:

  Backbone           log-mel [B,1,N_MELS,N_FRAMES] -> 128-d embedding (the part that
                     transfers from Surge pretraining to the XD fine-tune)
  SoundMatchEncoder  Backbone + XD multi-head (continuous [0,1] sigmoid, discrete logits,
                     boolean [0,1] sigmoid) — the model exported to ONNX
  SurgePretrainModel Backbone + a Surge-native regression head, used only to pretrain the
                     backbone; save model.backbone for transfer.

Requires torch (the `train` extra). Stick to ONNX-opset-17-clean ops.
"""

from __future__ import annotations

import torch
from torch import nn

from training import schema


class Backbone(nn.Module):
    EMBED_DIM = 128

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
        self.trunk = nn.Sequential(nn.Flatten(), nn.Linear(64, self.EMBED_DIM), nn.ReLU())

    def forward(self, mel: torch.Tensor) -> torch.Tensor:
        return self.trunk(self.features(mel))


class SoundMatchEncoder(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.backbone = Backbone()
        dim = Backbone.EMBED_DIM
        self.continuous = nn.Linear(dim, schema.N_CONTINUOUS)
        self.discrete = nn.Linear(dim, schema.TOTAL_DISCRETE)
        self.boolean = nn.Linear(dim, schema.N_BOOLEAN)

    def forward(
        self, mel: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        h = self.backbone(mel)
        return (
            torch.sigmoid(self.continuous(h)),
            self.discrete(h),
            torch.sigmoid(self.boolean(h)),
        )


class SurgePretrainModel(nn.Module):
    """Backbone + a Surge-native regression head ([0,1] params). Pretrain this, then save
    `model.backbone.state_dict()` to transfer the feature extractor to the XD fine-tune."""

    def __init__(self, n_params: int) -> None:
        super().__init__()
        self.backbone = Backbone()
        self.head = nn.Linear(Backbone.EMBED_DIM, n_params)

    def forward(self, mel: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.head(self.backbone(mel)))
