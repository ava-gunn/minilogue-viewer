"""Train the params -> CLAP-embedding proxy (Stage 2). Fits ParamProxy on a sweep dir
(samples.jsonl + embeddings.npy from training.data.embed) with a cosine loss, so the proxy
becomes a differentiable stand-in for the XD + CLAP encoder used in Stage 3.

    python -m training.proxy_train --data /Volumes/Samples/training/xd --out runs/proxy.pt
    python -m training.proxy_train --smoke    # no data/CLAP needed: exercise the loop

Requires torch (the `train` extra). Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from training import paramvec, xd_params
from training.model import proxy as proxy_model


def _device(name: str | None) -> torch.device:
    if name:
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def cosine_loss(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """1 - cosine similarity. Both rows are unit-norm, so this is in [0, 2]."""
    return (1.0 - (pred * target).sum(dim=-1)).mean()


def _load_data(data_dir: Path) -> tuple[torch.Tensor, torch.Tensor]:
    rows = [json.loads(line) for line in (data_dir / "samples.jsonl").read_text().splitlines()]
    x = np.stack([paramvec.targets_to_vector(r) for r in rows])
    y = np.asarray(np.load(data_dir / "embeddings.npy", mmap_mode="r"), dtype=np.float32)
    if len(x) != len(y):
        raise SystemExit(f"params/embeddings mismatch: {len(x)} rows vs {len(y)} embeddings")
    return torch.from_numpy(x), F.normalize(torch.from_numpy(y), dim=-1)


def _smoke_data(n: int, seed: int) -> tuple[torch.Tensor, torch.Tensor]:
    """Real param-vector structure (Sobol -> sample -> one-hot) mapped through a fixed random
    linear teacher, so a working trainer must drive val cosine up — proves the loop end to end."""
    x = np.stack(
        [paramvec.targets_to_vector(xd_params.sample(bytes(1024), u)[1]) for u in xd_params.sobol_unit(n, seed)]
    )
    g = torch.Generator().manual_seed(seed)
    xt = torch.from_numpy(x)
    w = torch.randn(paramvec.VEC_DIM, proxy_model.EMBED_DIM, generator=g)
    y = xt @ w + 0.01 * torch.randn(n, proxy_model.EMBED_DIM, generator=g)
    return xt, F.normalize(y, dim=-1)


@torch.no_grad()
def _val_cosine(model: nn.Module, x: torch.Tensor, y: torch.Tensor) -> float:
    model.eval()
    return float((model(x) * y).sum(dim=-1).mean())


def train(model, x, y, *, epochs, batch, lr, val_frac, device, seed) -> float:
    perm = torch.randperm(len(x), generator=torch.Generator().manual_seed(seed))
    n_val = max(1, int(len(x) * val_frac))
    vi, ti = perm[:n_val], perm[n_val:]
    xtr, ytr, xva, yva = x[ti].to(device), y[ti].to(device), x[vi].to(device), y[vi].to(device)
    model = model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr)
    start = _val_cosine(model, xva, yva)
    print(f"val cosine @init: {start:.4f}  (train {len(ti)}, val {len(vi)})")
    best = start
    for ep in range(1, epochs + 1):
        model.train()
        for b in torch.randperm(len(xtr), generator=torch.Generator().manual_seed(seed + ep)).split(batch):
            opt.zero_grad()
            cosine_loss(model(xtr[b]), ytr[b]).backward()
            opt.step()
        v = _val_cosine(model, xva, yva)
        best = max(best, v)
        if ep % max(1, epochs // 10) == 0 or ep == epochs:
            print(f"epoch {ep:>3}: val cosine {v:.4f}")
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, help="sweep dir (samples.jsonl + embeddings.npy)")
    ap.add_argument("--out", type=Path, default=Path("runs/proxy.pt"))
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--hidden", type=int, default=512)
    ap.add_argument("--depth", type=int, default=4)
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="train on a synthetic linear teacher")
    args = ap.parse_args()

    device = _device(args.device)
    x, y = _smoke_data(512, args.seed) if args.smoke else _load_data(args.data)
    model = proxy_model.ParamProxy(embed_dim=y.shape[1], hidden=args.hidden, depth=args.depth)
    best = train(
        model, x, y,
        epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed,
    )
    if args.smoke:
        assert best > 0.5, f"smoke: proxy failed to learn the teacher (best val cosine {best:.3f})"
        print(f"OK: smoke proxy reached val cosine {best:.4f}")
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "hidden": args.hidden, "depth": args.depth, "embed_dim": y.shape[1]}, args.out)
    print(f"saved proxy (val cosine {best:.4f}) -> {args.out}")


if __name__ == "__main__":
    main()
