"""Hardware-free quality gate for pulled contributions.

Contributions are Gemini PSEUDO-LABELS — params it guessed for some audio, never rendered on
the XD — so we can't score them against a ground-truth render without the hardware. Instead we
use the trained CLAP proxy as a stand-in for the synth: run each contribution's params through
the proxy to predict an audio embedding, and compare it (cosine) to the actual CLAP embedding of
the contribution's audio. High cosine = "params are consistent with the audio per the proxy's
model of the synth"; low = the pseudo-label is probably wrong.

    python -m training.eval.gate_contrib \\
        --data training/data/contrib --proxy runs/proxy.pt --threshold 0.5 \\
        --out training/data/contrib_accepted

Reads  <data>/samples.jsonl + <data>/embeddings.npy (from training.data.embed; 1:1 with samples
line order, near-silent rows zero-filled). Writes <out>/ as a fresh, training-ready split of only
the accepted rows (re-indexed so audio filenames match):
    <out>/samples.jsonl   (accepted rows, new sequential ids, + gate_cosine)
    <out>/audio/NNNNNN.wav (copied from <data>)
    <out>/embeddings.npy  (accepted subset, same order — no re-embed needed downstream)
    <out>/meta.json       (copied)
    <out>/gate.json       (full decision log)
and prints "kept K / scored N". The nightly job retrains on <out> only when K > 0.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import torch

from training import paramvec
from training.model import proxy as proxy_model

_REPO = Path(__file__).resolve().parents[2]
_EPS = 1e-6


def _load_proxy(path: Path, device: torch.device) -> torch.nn.Module:
    """Rebuild the proxy from its checkpoint. Mirrors training.encoder_train._load_proxy (keep in
    sync): reconstruct from the stored arch/config so older mlp-only checkpoints still load."""
    ckpt = torch.load(path, map_location=device)
    arch = ckpt.get("arch", "mlp")
    cfg = ckpt.get("config") or {"hidden": ckpt.get("hidden", 512), "depth": ckpt.get("depth", 4)}
    proxy = proxy_model.build_proxy(arch, embed_dim=ckpt["embed_dim"], **cfg)
    proxy.load_state_dict(ckpt["state_dict"])
    return proxy.eval().requires_grad_(False).to(device)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data", type=Path, default=_REPO / "training" / "data" / "contrib")
    ap.add_argument("--proxy", type=Path, default=_REPO / "runs" / "proxy.pt")
    ap.add_argument("--out", type=Path, default=_REPO / "training" / "data" / "contrib_accepted")
    ap.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="min proxy/audio cosine to accept (1 - cosine is the proxy's training loss)",
    )
    args = ap.parse_args()

    samples_path = args.data / "samples.jsonl"
    emb_path = args.data / "embeddings.npy"
    if not samples_path.exists():
        ap.error(f"no samples at {samples_path}")
    if not emb_path.exists():
        ap.error(f"no embeddings at {emb_path} — run `python -m training.data.embed --data {args.data}`")
    if not args.proxy.exists():
        ap.error(f"no proxy checkpoint at {args.proxy}")
    if args.out.resolve() == args.data.resolve():
        ap.error("--out must differ from --data (it gets wiped and rewritten each run)")
    # Only ever wipe a dir we created (carries gate.json) or an empty/absent one — never a dir we
    # don't own (e.g. someone passing the real contrib store).
    if args.out.exists() and any(args.out.iterdir()) and not (args.out / "gate.json").exists():
        ap.error(f"{args.out} isn't a gate output dir (no gate.json) — refusing to overwrite")

    rows = [json.loads(line) for line in samples_path.read_text().splitlines() if line.strip()]
    emb = np.load(emb_path).astype(np.float32)
    if len(rows) != len(emb):
        ap.error(f"alignment mismatch: {len(rows)} samples vs {len(emb)} embeddings — re-run embed")

    if args.out.exists():
        shutil.rmtree(args.out)
    (args.out / "audio").mkdir(parents=True, exist_ok=True)

    if not rows:
        (args.out / "gate.json").write_text(json.dumps({"threshold": args.threshold, "scored": 0, "kept": 0}))
        print("kept 0 / scored 0 (no contributions)")
        return

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    proxy = _load_proxy(args.proxy, device)

    params = torch.from_numpy(np.stack([paramvec.targets_to_vector(r) for r in rows])).to(device)
    with torch.no_grad():
        pred = proxy(params)  # [N, D], unit-norm (the proxy normalizes internally)
    target = torch.nn.functional.normalize(torch.from_numpy(emb).to(device), dim=-1)
    cos = (pred * target).sum(dim=-1).cpu().numpy()

    audible = np.linalg.norm(emb, axis=1) > _EPS  # silent clips are zero-filled by embed.py
    keep = audible & (cos >= args.threshold)
    kept_idx = np.nonzero(keep)[0]

    acc_rows = []
    for new_id, i in enumerate(kept_idx):
        row = dict(rows[i])
        orig_id = int(row["id"])
        shutil.copyfile(
            args.data / "audio" / f"{orig_id:06d}.wav",
            args.out / "audio" / f"{new_id:06d}.wav",
        )
        row["id"] = new_id
        row["gate_cosine"] = float(cos[i])
        acc_rows.append(row)

    if acc_rows:
        (args.out / "samples.jsonl").write_text("\n".join(json.dumps(r) for r in acc_rows) + "\n")
        np.save(args.out / "embeddings.npy", emb[kept_idx])
        meta_src = args.data / "meta.json"
        if meta_src.exists():
            shutil.copyfile(meta_src, args.out / "meta.json")

    (args.out / "gate.json").write_text(
        json.dumps(
            {
                "threshold": args.threshold,
                "scored": len(rows),
                "kept": int(keep.sum()),
                "rejected": int((~keep).sum()),
                "cosine": {
                    "min": float(cos.min()),
                    "median": float(np.median(cos)),
                    "max": float(cos.max()),
                },
                "decisions": [
                    {
                        "contribution_id": rows[i].get("contribution_id"),
                        "cosine": float(cos[i]),
                        "kept": bool(keep[i]),
                        "audible": bool(audible[i]),
                    }
                    for i in range(len(rows))
                ],
            },
            indent=2,
        )
    )

    print(
        f"kept {int(keep.sum())} / scored {len(rows)} "
        f"(threshold {args.threshold}; cosine min={cos.min():.3f} "
        f"med={np.median(cos):.3f} max={cos.max():.3f}) -> {args.out}"
    )


if __name__ == "__main__":
    main()
