"""Precompute CLAP audio embeddings for a sweep dir (Stage 2 target). These are the
perceptually-grounded vectors the proxy learns to predict from params.

    python -m training.data.embed --data /Volumes/Samples/training/xd

Reads samples.jsonl, embeds each audio/<id>.wav, and writes embeddings.npy [N, 512]
(memmap, row-aligned to clip id) + embeddings.meta.json. Resumable by stored count.

laion-clap + librosa are imported lazily (the `proxy` extra) so this module still imports
without them; the checkpoint downloads on first use. Requires the `proxy` extra to run.
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

TARGET_SR = 48000  # laion-clap operates at 48 kHz
EMBED_DIM = 512


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    """Mono float32 in [-1, 1] + sample rate, matching xd_record's 16-bit PCM writer."""
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    if w.getnchannels() > 1:
        pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1)
    return pcm.astype(np.float32) / 32768.0, sr


class ClapEmbedder:
    """Thin wrapper over laion_clap: resample to 48 kHz, return L2-comparable embeddings."""

    def __init__(self, ckpt: str | None = None) -> None:
        import laion_clap  # lazy: the `proxy` extra

        self._librosa = __import__("librosa")
        self.model = laion_clap.CLAP_Module(enable_fusion=False)
        self.model.load_ckpt(ckpt) if ckpt else self.model.load_ckpt()

    def embed_batch(self, clips: list[np.ndarray], sr: int) -> np.ndarray:
        if sr != TARGET_SR:
            clips = [self._librosa.resample(c, orig_sr=sr, target_sr=TARGET_SR) for c in clips]
        width = max(c.shape[0] for c in clips)
        batch = np.stack([np.pad(c, (0, width - c.shape[0])) for c in clips]).astype(np.float32)
        emb = self.model.get_audio_embedding_from_data(x=batch, use_tensor=False)
        return np.asarray(emb, dtype=np.float32)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, required=True, help="sweep dir (has samples.jsonl + audio/)")
    ap.add_argument("--ckpt", default=None, help="CLAP checkpoint path (default: laion-clap's)")
    ap.add_argument("--batch", type=int, default=32)
    args = ap.parse_args()

    rows = [json.loads(line) for line in (args.data / "samples.jsonl").read_text().splitlines()]
    n = len(rows)
    emb_path = args.data / "embeddings.npy"
    meta_path = args.data / "embeddings.meta.json"
    embeddings = np.lib.format.open_memmap(
        emb_path, mode="r+" if emb_path.exists() else "w+", dtype=np.float32, shape=(n, EMBED_DIM)
    )
    done = json.loads(meta_path.read_text())["done"] if meta_path.exists() else 0
    if done >= n:
        print(f"already embedded {done}/{n} at {emb_path}")
        return
    print(f"embedding {n - done}/{n} clips (resume from {done}) -> {emb_path}")

    embedder = ClapEmbedder(args.ckpt)
    for lo in range(done, n, args.batch):
        chunk = rows[lo : lo + args.batch]
        clips, sr = zip(*(read_wav(args.data / "audio" / f"{r['id']:06d}.wav") for r in chunk))
        embeddings[lo : lo + len(chunk)] = embedder.embed_batch(list(clips), sr[0])
        embeddings.flush()
        meta_path.write_text(json.dumps({"n": n, "dim": EMBED_DIM, "target_sr": TARGET_SR, "done": lo + len(chunk)}))
        print(f"{lo + len(chunk)}/{n} embedded")
    print(f"done: {n} embeddings at {emb_path}")


if __name__ == "__main__":
    main()
