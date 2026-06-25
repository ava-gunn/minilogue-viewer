"""Audio similarity metrics for the resynthesis eval. The headline metric is log-mel L1
using the model's *own* mel (training/data/mel.py), so the distance is in the same space
the encoder sees; MFCC-L2 and multi-scale log-STFT-L1 are perceptual second opinions.

Both signals are fit to N_SAMPLES and RMS-normalized (so program level doesn't dominate).
Pass lowpass_hz to band-limit a full-band XD recording to match a band-limited source
(e.g. 8000 for 16 kHz NSynth) before scoring. Lower is closer.
"""

from __future__ import annotations

import numpy as np

from training import schema
from training.data.mel import log_mel

SR = schema.AUDIO["sample_rate"]


def fit(x: np.ndarray, n: int = schema.N_SAMPLES) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if len(x) >= n:
        return x[:n]
    out = np.zeros(n, dtype=np.float32)
    out[: len(x)] = x
    return out


def rms_normalize(x: np.ndarray, target: float = 0.1) -> np.ndarray:
    r = float(np.sqrt(np.mean(x**2)))
    return x if r < 1e-9 else (x * (target / r)).astype(np.float32)


def lowpass(x: np.ndarray, cutoff: float, sr: int = SR) -> np.ndarray:
    """Brick-wall low-pass via rFFT (zero bins above cutoff) — dependency-free."""
    spec = np.fft.rfft(x)
    spec[np.fft.rfftfreq(len(x), 1.0 / sr) > cutoff] = 0
    return np.fft.irfft(spec, n=len(x)).astype(np.float32)


def _stft_logmag(x: np.ndarray, n_fft: int) -> np.ndarray:
    hop = n_fft // 4
    win = np.hanning(n_fft).astype(np.float32)
    frames = [
        np.abs(np.fft.rfft(x[i : i + n_fft] * win))
        for i in range(0, len(x) - n_fft + 1, hop)
    ]
    if not frames:
        return np.zeros((1, n_fft // 2 + 1), dtype=np.float32)
    return np.log(np.stack(frames) + 1e-6)


def multiscale_stft_l1(a: np.ndarray, b: np.ndarray, ffts=(512, 1024, 2048)) -> float:
    total = 0.0
    for n in ffts:
        la, lb = _stft_logmag(a, n), _stft_logmag(b, n)
        m = min(len(la), len(lb))
        total += float(np.mean(np.abs(la[:m] - lb[:m])))
    return total / len(ffts)


def compare(source: np.ndarray, xd: np.ndarray, *, lowpass_hz: float | None = None) -> dict:
    """Distances between an original clip and an XD render of the predicted program."""
    a = rms_normalize(fit(source))
    b = rms_normalize(fit(xd))
    if lowpass_hz:
        a, b = lowpass(a, lowpass_hz), lowpass(b, lowpass_hz)

    ma, mb = log_mel(a), log_mel(b)
    out = {
        "mel_l1": float(np.mean(np.abs(ma - mb))),
        "mel_l2": float(np.sqrt(np.mean((ma - mb) ** 2))),
        "mss_l1": multiscale_stft_l1(a, b),
    }
    try:  # MFCC uses librosa's own mel; a second opinion, optional.
        import librosa

        ca = librosa.feature.mfcc(y=a, sr=SR, n_mfcc=20)
        cb = librosa.feature.mfcc(y=b, sr=SR, n_mfcc=20)
        out["mfcc_l2"] = float(np.sqrt(np.mean((ca - cb) ** 2)))
    except Exception:
        pass
    return out
