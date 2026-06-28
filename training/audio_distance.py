"""Cheap audio distance for in-the-loop sound matching.

distance(target, render) -> float : log-mel-spectrogram L1, lower = closer. Numpy + librosa
only — no model, no training, no GPU. The waveform is peak-normalized and onset-trimmed first;
without that the score tracks loudness/latency noise instead of timbre and cross-iteration
comparisons stop being meaningful. Intended loop: render a candidate patch on the synth, record
~1s, call distance() against the target, keep the change if it dropped.

    python training/audio_distance.py                # run self-test
    python training/audio_distance.py a.wav b.wav    # print distance, write diff.png
"""

import librosa
import numpy as np

SR = 44100
N = SR  # 1 second — the working clip length


def load(path, sr=SR):
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y


def _prep(y, n=N):
    """Mono, onset-trimmed to a fixed 1s window, peak-normalized to [-1, 1]."""
    y = np.asarray(y, dtype=np.float32)
    if y.ndim > 1:
        y = librosa.to_mono(y)
    y, _ = librosa.effects.trim(y, top_db=30)  # drop leading/trailing silence -> align onsets
    y = np.pad(y[:n], (0, max(0, n - len(y))))
    peak = float(np.max(np.abs(y)))
    return y / peak if peak > 1e-9 else y


def _logmel(y):
    s = librosa.feature.melspectrogram(y=y, sr=SR, n_fft=2048, hop_length=512, n_mels=128)
    ref = np.max(s)
    return librosa.power_to_db(s, ref=ref if ref > 0 else 1.0)


def _distance_prepped(a, b):
    return float(np.abs(_logmel(a) - _logmel(b)).mean())


def distance(target, render):
    """Log-mel L1 distance; 0 = identical, larger = more different."""
    return _distance_prepped(_prep(target), _prep(render))


def closer(target, new, old):
    """True if `new` matches `target` better than `old` does."""
    return distance(target, new) < distance(target, old)


class Tracker:
    """Best-so-far tracker for a search loop. Preps the target once; consider() reports whether
    each candidate beat the best seen so far and records the new best."""

    def __init__(self, target):
        self._target = _prep(target)
        self.best = float("inf")
        self.best_render = None
        self.history = []

    def consider(self, render):
        d = _distance_prepped(self._target, _prep(render))
        self.history.append(d)
        if d < self.best:
            self.best, self.best_render = d, render
            return True
        return False


def diff_png(target, render, out="diff.png"):
    """Write a 3-panel mel-spectrogram comparison (target, render, signed difference: red =
    render too hot, blue = too cold). For eyeballing, separate from the loop metric."""
    import matplotlib

    matplotlib.use("Agg")
    import librosa.display
    import matplotlib.pyplot as plt

    ma, mb = _logmel(_prep(target)), _logmel(_prep(render))
    fig, ax = plt.subplots(3, 1, figsize=(8, 9), constrained_layout=True)
    for m, axis, title in [(ma, ax[0], "target"), (mb, ax[1], "render")]:
        librosa.display.specshow(m, sr=SR, hop_length=512, x_axis="time", y_axis="mel", ax=axis)
        axis.set_title(title)
    im = librosa.display.specshow(
        mb - ma, sr=SR, hop_length=512, x_axis="time", y_axis="mel", ax=ax[2], cmap="coolwarm"
    )
    ax[2].set_title("render - target")
    fig.colorbar(im, ax=ax[2], format="%+.0f dB")
    fig.savefig(out, dpi=100)
    plt.close(fig)
    return out


# ── self-test: synthetic signals, no hardware ──
def _saw(freq, n=N):
    t = np.arange(n) / SR
    y = np.zeros(n, dtype=np.float32)
    k = 1
    while freq * k < SR / 2:
        y += ((-1) ** (k + 1)) * np.sin(2 * np.pi * freq * k * t) / k
        k += 1
    return y


def _sine(freq, n=N):
    return np.sin(2 * np.pi * freq * np.arange(n) / SR).astype(np.float32)


def _env(n=N, attack=0.01, decay=0.3):
    t = np.arange(n) / SR
    return (np.clip(t / attack, 0, 1) * np.exp(-np.maximum(t - attack, 0) / decay)).astype(np.float32)


def _selftest():
    target = _saw(220) * _env()
    good = _saw(222) * _env(decay=0.28)  # ~2 Hz detune, slightly faster decay -> near match
    bad = _sine(440) * _env()  # octave up, pure tone -> clearly different

    d_self, d_good, d_bad = distance(target, target), distance(target, good), distance(target, bad)
    print(f"distance(target, target) = {d_self:.4f}")
    print(f"distance(target, good)   = {d_good:.4f}   (saw 222 Hz)")
    print(f"distance(target, bad)    = {d_bad:.4f}   (sine 440 Hz)")

    assert d_self < 1e-6, f"identical clips should score ~0, got {d_self}"
    assert d_good < d_bad, f"good ({d_good:.3f}) should rank below bad ({d_bad:.3f})"
    assert closer(target, good, bad), "closer() disagrees with distance()"

    t = Tracker(target)
    assert t.consider(bad) is True  # first candidate beats inf
    assert t.consider(good) is True  # good beats bad
    assert t.consider(bad) is False  # bad doesn't beat good
    assert t.best_render is good
    print(f"Tracker best = {t.best:.4f}, history = {[round(x, 3) for x in t.history]}")
    print("PASS")


if __name__ == "__main__":
    import sys

    argv = sys.argv[1:]
    if len(argv) >= 2 and not argv[0].startswith("-"):
        a, b = load(argv[0]), load(argv[1])
        print(f"distance = {distance(a, b):.4f}")
        print("wrote", diff_png(a, b, argv[2] if len(argv) > 2 else "diff.png"))
    else:
        _selftest()
