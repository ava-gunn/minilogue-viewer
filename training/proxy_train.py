"""Train the params -> CLAP-embedding proxy (Stage 2). Fits ParamProxy on a sweep dir
(samples.jsonl + embeddings.npy from training.data.embed) with a cosine loss, so the proxy
becomes a differentiable stand-in for the XD + CLAP encoder used in Stage 3.

    python -m training.proxy_train --data /Volumes/Samples/training/xd --out runs/proxy.pt
    python -m training.proxy_train --smoke    # no data/CLAP needed: exercise the loop

Requires torch (the `train` extra). Run from the repo root.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from training import paramvec, xd_params
from training.data.sweep_dataset import RMS_FLOOR, audible_mask
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


def _load_data(dirs: list[Path]) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Concatenate one or more dirs (sweep + rendered presets). Returns (param vectors,
    embeddings unit-norm, is_eval bool); split=="eval" rows are held out of training."""
    xs, ys, ev = [], [], []
    for d in dirs:
        rows = [json.loads(line) for line in (d / "samples.jsonl").read_text().splitlines()]
        y = np.array(np.load(d / "embeddings.npy", mmap_mode="r"), dtype=np.float32)  # copy: writable for torch
        if len(rows) != len(y):
            raise SystemExit(f"{d}: {len(rows)} rows vs {len(y)} embeddings")
        keep = audible_mask(rows)
        if not keep.all():
            print(f"{d}: dropping {int((~keep).sum())}/{len(rows)} near-silent clips (rms<{RMS_FLOOR})")
        rows = [r for r, k in zip(rows, keep) if k]
        xs.append(np.stack([paramvec.targets_to_vector(r) for r in rows]))
        ys.append(y[keep])
        ev.extend(r.get("split") == "eval" for r in rows)
    return (
        torch.from_numpy(np.concatenate(xs)),
        F.normalize(torch.from_numpy(np.concatenate(ys)), dim=-1),
        torch.tensor(ev),
    )


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


def train(model, x, y, *, epochs, batch, lr, val_frac, device, seed, eval_mask=None) -> float:
    if eval_mask is not None and bool(eval_mask.any()):  # held-out presets are the val set
        vi = torch.nonzero(eval_mask, as_tuple=False).flatten()
        ti = torch.nonzero(~eval_mask, as_tuple=False).flatten()
    else:
        perm = torch.randperm(len(x), generator=torch.Generator().manual_seed(seed))
        n_val = max(1, int(len(x) * val_frac))
        vi, ti = perm[:n_val], perm[n_val:]
    xtr, ytr, xva, yva = x[ti].to(device), y[ti].to(device), x[vi].to(device), y[vi].to(device)
    model = model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr)
    start = _val_cosine(model, xva, yva)
    print(f"val cosine @init: {start:.4f}  (train {len(ti)}, val {len(vi)})")
    best = start
    best_state = copy.deepcopy(model.state_dict())
    for ep in range(1, epochs + 1):
        model.train()
        for b in torch.randperm(len(xtr), generator=torch.Generator().manual_seed(seed + ep)).split(batch):
            opt.zero_grad()
            cosine_loss(model(xtr[b]), ytr[b]).backward()
            opt.step()
        v = _val_cosine(model, xva, yva)
        if v > best:
            best, best_state = v, copy.deepcopy(model.state_dict())
        if ep % max(1, epochs // 10) == 0 or ep == epochs:
            print(f"epoch {ep:>3}: val cosine {v:.4f}")
    model.load_state_dict(best_state)  # restore the best epoch, not the last
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, nargs="+", help="one or more dirs (sweep + rendered presets)")
    ap.add_argument("--out", type=Path, default=Path("runs/proxy.pt"))
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--arch", choices=["mlp", "transformer"], default="transformer",
                    help="proxy architecture (transformer models param interdependencies better)")
    ap.add_argument("--hidden", type=int, default=512, help="mlp: hidden width")
    ap.add_argument("--depth", type=int, default=4, help="mlp: layers")
    ap.add_argument("--d-token", type=int, default=192, help="transformer: token/model dim")
    ap.add_argument("--layers", type=int, default=4, help="transformer: encoder layers")
    ap.add_argument("--heads", type=int, default=6, help="transformer: attention heads")
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="train on a synthetic linear teacher")
    args = ap.parse_args()

    device = _device(args.device)
    if args.smoke:
        x, y, eval_mask = (*_smoke_data(512, args.seed), None)
    else:
        x, y, eval_mask = _load_data(args.data)
    cfg = (
        {"hidden": args.hidden, "depth": args.depth}
        if args.arch == "mlp"
        else {"d_token": args.d_token, "layers": args.layers, "heads": args.heads}
    )
    model = proxy_model.build_proxy(args.arch, embed_dim=y.shape[1], **cfg)
    best = train(
        model, x, y,
        epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed, eval_mask=eval_mask,
    )
    if args.smoke:
        assert best > 0.5, f"smoke: {args.arch} proxy failed to learn the teacher (best val cosine {best:.3f})"
        print(f"OK: smoke {args.arch} proxy reached val cosine {best:.4f}")
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"arch": args.arch, "config": cfg, "embed_dim": y.shape[1], "state_dict": model.state_dict()}, args.out)
    print(f"saved {args.arch} proxy (val cosine {best:.4f}) -> {args.out}")


if __name__ == "__main__":
    main()
