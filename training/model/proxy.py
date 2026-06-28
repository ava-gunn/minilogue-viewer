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
    def __init__(self, embed_dim: int = EMBED_DIM, hidden: int = 512, depth: int = 4, normalize: bool = True) -> None:
        super().__init__()
        self.normalize = normalize
        blocks: list[nn.Module] = [nn.Linear(paramvec.VEC_DIM, hidden), nn.LayerNorm(hidden), nn.GELU()]
        for _ in range(depth - 1):
            blocks += [nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.GELU()]
        self.net = nn.Sequential(*blocks)
        self.head = nn.Linear(hidden, embed_dim)

    def forward(self, params: torch.Tensor) -> torch.Tensor:
        out = self.head(self.net(params))
        return torch.nn.functional.normalize(out, dim=-1) if self.normalize else out


class ParamProxyTransformer(nn.Module):
    """One token per parameter (continuous/boolean = a learnable vector scaled by the value;
    discrete = a soft lookup over learnable category embeddings, so the soft one-hot from the
    Stage-3 bridge stays differentiable), + a CLS token whose output is projected to the
    embedding."""

    def __init__(
        self, embed_dim: int = EMBED_DIM, d_token: int = 192, layers: int = 4, heads: int = 6,
        ff: int | None = None, dropout: float = 0.1, normalize: bool = True,
    ) -> None:
        super().__init__()
        self.normalize = normalize
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
        out = self.head(self.encoder(x)[:, 0])
        return torch.nn.functional.normalize(out, dim=-1) if self.normalize else out


class MelSpecProxy(nn.Module):
    """params -> full log-mel spectrogram [N_MELS, N_FRAMES] (raw log-mel, not normalized):
    a differentiable stand-in for "render on the XD -> log-mel", for the Stage-3 spectral-
    reconstruction objective. Reuses the per-parameter token + transformer tower (param
    interdependencies, Combes et al.) for a context vector, then a transposed-conv decoder
    upsamples it to the spectrogram. Trained by training.mel_proxy_train --target full."""

    def __init__(
        self, d_token: int = 192, layers: int = 4, heads: int = 6,
        ff: int | None = None, dropout: float = 0.1, dec_ch: int = 64,
    ) -> None:
        super().__init__()
        nc, td, nb = schema.N_CONTINUOUS, schema.TOTAL_DISCRETE, schema.N_BOOLEAN
        self._disc_slices: list[tuple[int, int]] = []
        off = 0
        for card in schema.DISCRETE_CARDINALITIES:
            self._disc_slices.append((off, off + card))
            off += card
        self.cont_w = nn.Parameter(torch.randn(nc, d_token) * 0.02)
        self.cont_b = nn.Parameter(torch.zeros(nc, d_token))
        self.disc_w = nn.Parameter(torch.randn(td, d_token) * 0.02)
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
        # transposed-conv decoder: 3× ×2 upsamples from a seed grid to >= [N_MELS, N_FRAMES], then crop.
        self._dec_ch = dec_ch
        self._h0, self._w0 = schema.N_MELS // 8, -(-schema.N_FRAMES // 8)  # ceil-div on frames
        self.proj = nn.Linear(d_token, dec_ch * self._h0 * self._w0)
        self.dec = nn.Sequential(
            nn.ConvTranspose2d(dec_ch, dec_ch, 4, 2, 1), nn.GELU(),
            nn.ConvTranspose2d(dec_ch, dec_ch // 2, 4, 2, 1), nn.GELU(),
            nn.ConvTranspose2d(dec_ch // 2, dec_ch // 4, 4, 2, 1), nn.GELU(),
            nn.Conv2d(dec_ch // 4, 1, 3, 1, 1),
        )

    def forward(self, params: torch.Tensor) -> torch.Tensor:
        cont, disc, boolean = _split(params)
        cont_tok = cont.unsqueeze(-1) * self.cont_w + self.cont_b
        bool_tok = boolean.unsqueeze(-1) * self.bool_w + self.bool_b
        disc_tok = torch.stack([disc[:, a:b] @ self.disc_w[a:b] for a, b in self._disc_slices], dim=1)
        tokens = torch.cat([cont_tok, disc_tok, bool_tok], dim=1)
        x = torch.cat([self.cls.expand(tokens.size(0), -1, -1), tokens], dim=1) + self.pos
        g = self.proj(self.encoder(x)[:, 0]).view(-1, self._dec_ch, self._h0, self._w0)
        mel = self.dec(g)  # [B, 1, N_MELS, >=N_FRAMES]
        return mel[:, 0, : schema.N_MELS, : schema.N_FRAMES]


def build_proxy(arch: str = "mlp", embed_dim: int = EMBED_DIM, normalize: bool = True, **cfg) -> nn.Module:
    """Construct a proxy by name. cfg keys: mlp -> hidden, depth; transformer -> d_token,
    layers, heads. normalize=False gives a raw (non-unit) output for a spectral/log-mel target.
    Used by proxy_train / mel_proxy_train and encoder_train (reconstruct from checkpoint)."""
    if arch == "mlp":
        return ParamProxy(embed_dim, hidden=cfg.get("hidden", 512), depth=cfg.get("depth", 4), normalize=normalize)
    if arch == "transformer":
        return ParamProxyTransformer(
            embed_dim, d_token=cfg.get("d_token", 192), layers=cfg.get("layers", 4),
            heads=cfg.get("heads", 6), normalize=normalize,
        )
    if arch == "melspec":  # params -> full log-mel [N_MELS, N_FRAMES]; embed_dim/normalize unused
        return MelSpecProxy(
            d_token=cfg.get("d_token", 192), layers=cfg.get("layers", 4),
            heads=cfg.get("heads", 6), dec_ch=cfg.get("dec_ch", 64),
        )
    raise ValueError(f"unknown proxy arch {arch!r}")
