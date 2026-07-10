"""Reusable CLAP-cosine perceptual scorer: candidate/render audio -> distance to a target via
the laion-clap embedding the encoder trains against. Loads the model once.

Validated in `metric_correlation.py` (n=135, 71% agreement with blind 2AFC — the best of the
tested metrics, and the only one that tracks the pitch A/B). Use it as a PREDICTOR / final
RE-RANKER, NOT as a CMA-ES inner-loop objective: encoders/optimizers game a frozen CLAP (recon
arc), and a forward per candidate is far costlier than mss_l1. See [[resynth-metric-bakeoff]].
"""

from __future__ import annotations

import numpy as np

from training.eval import infer, metrics

SR = infer.SR


class ClapScorer:
    """Lazy laion-clap wrapper. distances() preps each clip the same way refine's spectral
    score does (fit to the model window + RMS-normalize) so render/target are commensurate."""

    def __init__(self, ckpt: str | None = None) -> None:
        from training.data.embed import ClapEmbedder  # lazy: the `proxy` extra + a big ckpt

        self._emb = ClapEmbedder(ckpt)

    def _embed(self, clips: list[np.ndarray], sr: int) -> np.ndarray:
        e = self._emb.embed_batch([np.asarray(c, dtype=np.float32) for c in clips], sr)
        return e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-8)

    def distances(self, cands: list[np.ndarray], target: np.ndarray, sr: int = SR) -> np.ndarray:
        """CLAP-cosine distance (1 - cosine, lower = perceptually closer) of each candidate to
        the target. Inputs are raw mono audio at `sr`; prep + embedding happen here."""
        clips = [metrics.rms_normalize(metrics.fit(c)) for c in [target, *cands]]
        e = self._embed(clips, sr)
        return 1.0 - (e[1:] @ e[0])
