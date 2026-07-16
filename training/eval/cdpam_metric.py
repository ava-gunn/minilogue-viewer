"""Non-circular perceptual scorer via CDPAM (Manocha et al., 2021): a learned audio distance
trained on human "are these the same?" JND judgments — INDEPENDENT of the laion-clap embedding the
encoder/proxy train against, so (unlike CLAP-cosine) it can't be flattered by our own training
target. Use it as a screen / A/B predictor, and a candidate objective CLAP's circularity rules out.

Requires `pip install cdpam` (pulls a pretrained checkpoint on first use). CDPAM runs at 22.05 kHz.
See [[resynth-metric-bakeoff]] and metric_correlation.py for validation against blind 2AFC.
"""

from __future__ import annotations

import numpy as np

from training.eval import infer

SR = infer.SR
CDPAM_SR = 22050


class CdpamScorer:
    """Lazy CDPAM wrapper. distance() takes raw mono audio at `sr`, resamples to CDPAM's 22.05 kHz,
    formats it the way `cdpam.load_audio` does (int16-scaled, shape [1, N]), and returns the
    perceptual distance (lower = perceptually closer)."""

    def __init__(self) -> None:
        import functools

        import cdpam  # lazy: heavy dep + downloads a ckpt
        import torch

        # cdpam's checkpoint predates PyTorch 2.6's weights_only=True default; it's the package's
        # own (trusted) ckpt, so load it full-pickle.
        _orig = torch.load
        torch.load = functools.partial(_orig, weights_only=False, map_location="cpu")
        try:
            self._m = cdpam.CDPAM(dev="cpu")  # no CUDA on this Mac
        finally:
            torch.load = _orig

    def _to_tensor(self, x: np.ndarray, sr: int):
        import librosa
        import torch

        y = np.asarray(x, dtype=np.float32)
        if sr != CDPAM_SR:
            y = librosa.resample(y, orig_sr=sr, target_sr=CDPAM_SR)
        pcm = np.round(np.clip(y, -1.0, 1.0) * 32768.0).astype(np.int16)
        return torch.from_numpy(pcm.reshape(1, -1).astype(np.float32))

    def distance(self, cand: np.ndarray, target: np.ndarray, sr: int = SR) -> float:
        d = self._m.forward(self._to_tensor(target, sr), self._to_tensor(cand, sr))
        return float(np.asarray(getattr(d, "detach", lambda: d)()).reshape(-1)[0])
