"""params -> CLAP-embedding proxy (Stage 2): a small network that approximates the
Minilogue XD + CLAP audio encoder as a single differentiable stand-in for the hardware.

Input is the flattened param vector (training/paramvec.py); output is an L2-normalized
embedding compared to the real CLAP embedding by cosine. Once trained and frozen, gradients
flow through it back to the sound-matching encoder in Stage 3, so no hardware is touched
during encoder training. Requires torch (the `train` extra).

Two architectures (Combes et al. 2025, "Neural Proxies for Sound Synthesizers", find a
transformer over per-parameter tokens clearly beats an MLP at modelling parameter
interdependencies — most so for complex synths):
  ParamProxy            flat-vector MLP (cheap baseline)
  ParamProxyTransformer per-parameter tokens + CLS + transformer encoder

The proxy is training-only and never exported to ONNX, so it is free of the opset-17
constraints that bind the encoder. Build either via build_proxy(arch, ...).
"""

from __future__ import annotations

import torch
from torch import nn

from training import paramvec, schema

EMBED_DIM = 512  # laion-clap audio embedding width


def _split(params: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """117-d proxy vector -> (continuous [B,NC], discrete one-hot [B,TD], boolean [B,NB])."""
    nc, td = schema.N_CONTINUOUS, schema.TOTAL_DISCRETE
    return params[:, :nc], params[:, nc : nc + td], params[:, nc + td :]


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


class ParamProxyTransformer(nn.Module):
    """One token per parameter (continuous/boolean = a learnable vector scaled by the value;
    discrete = a soft lookup over learnable category embeddings, so the soft one-hot from the
    Stage-3 bridge stays differentiable), + a CLS token whose output is projected to the
    embedding."""

    def __init__(
        self, embed_dim: int = EMBED_DIM, d_token: int = 192, layers: int = 4, heads: int = 6,
        ff: int | None = None, dropout: float = 0.1,
    ) -> None:
        super().__init__()
        nc, td, nb = schema.N_CONTINUOUS, schema.TOTAL_DISCRETE, schema.N_BOOLEAN
        self._nc, self._td = nc, td
        self._disc_slices: list[tuple[int, int]] = []
        off = 0
        for card in schema.DISCRETE_CARDINALITIES:
            self._disc_slices.append((off, off + card))
            off += card
        self.cont_w = nn.Parameter(torch.randn(nc, d_token) * 0.02)
        self.cont_b = nn.Parameter(torch.zeros(nc, d_token))
        self.disc_w = nn.Parameter(torch.randn(td, d_token) * 0.02)  # per-category embeddings
        self.bool_w = nn.Parameter(torch.randn(nb, d_token) * 0.02)
        self.bool_b = nn.Parameter(torch.zeros(nb, d_token))
        n_tokens = nc + len(self._disc_slices) + nb
        self.cls = nn.Parameter(torch.zeros(1, 1, d_token))
        self.pos = nn.Parameter(torch.randn(1, n_tokens + 1, d_token) * 0.02)
        layer = nn.TransformerEncoderLayer(
            d_token, heads, ff or 4 * d_token, dropout=dropout,
            activation="gelu", batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, layers)
        self.head = nn.Linear(d_token, embed_dim)

    def forward(self, params: torch.Tensor) -> torch.Tensor:
        cont, disc, boolean = _split(params)
        cont_tok = cont.unsqueeze(-1) * self.cont_w + self.cont_b
        bool_tok = boolean.unsqueeze(-1) * self.bool_w + self.bool_b
        disc_tok = torch.stack([disc[:, a:b] @ self.disc_w[a:b] for a, b in self._disc_slices], dim=1)
        tokens = torch.cat([cont_tok, disc_tok, bool_tok], dim=1)
        x = torch.cat([self.cls.expand(tokens.size(0), -1, -1), tokens], dim=1) + self.pos
        return torch.nn.functional.normalize(self.head(self.encoder(x)[:, 0]), dim=-1)


def build_proxy(arch: str = "mlp", embed_dim: int = EMBED_DIM, **cfg) -> nn.Module:
    """Construct a proxy by name. cfg keys: mlp -> hidden, depth; transformer -> d_token,
    layers, heads. Used by proxy_train (new) and encoder_train (reconstruct from checkpoint)."""
    if arch == "mlp":
        return ParamProxy(embed_dim, hidden=cfg.get("hidden", 512), depth=cfg.get("depth", 4))
    if arch == "transformer":
        return ParamProxyTransformer(
            embed_dim, d_token=cfg.get("d_token", 192), layers=cfg.get("layers", 4), heads=cfg.get("heads", 6)
        )
    raise ValueError(f"unknown proxy arch {arch!r}")
