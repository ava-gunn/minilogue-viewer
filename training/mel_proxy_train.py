"""Train a params -> pooled-log-mel SPECTRAL proxy (experiment). A differentiable stand-in
for the XD's spectral envelope, to add a spectral-reconstruction loss to Stage-3 encoder
training alongside the CLAP proxy.

Motivation (2026-06-27 hardware eval, see [[preset-finetune-result]]): the CLAP proxy alone
improves parameter recovery but *regresses* the hardware mel_l1 audio match — CLAP optimizes
semantic similarity, not spectrum. This proxy gives the encoder a differentiable spectral
distance so it can also minimize mel_l1.

Target = time-mean of each clip's log-mel ([N_MELS]) — the spectral envelope, which dominates
mel_l1 and is cheap to predict (full-spectrogram is the obvious escalation). Loss = L1; output
is NOT L2-normalized (raw log-mel scale, hence build_proxy normalize=False). Held-out presets
(split=="eval") are the val set. Saves a checkpoint that `encoder_train --mel-proxy` consumes.

    python -m training.mel_proxy_train --data /Volumes/Samples/training/xd /Volumes/Samples/training/presets --out runs/mel_proxy.pt
    python -m training.mel_proxy_train --smoke    # synthetic linear teacher; no data/CLAP

Requires torch (the `train` extra). Run from the repo root.
"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training import paramvec, schema, xd_params
from training.model import proxy as proxy_model
from training.proxy_train import _device


def pooled_mel(mels) -> torch.Tensor:
    """[N, N_MELS, N_FRAMES] log-mel -> [N, N_MELS] time-mean (the spectral envelope target)."""
    return torch.from_numpy(np.asarray(mels).mean(axis=-1).astype(np.float32))


def _smoke_data(n: int, seed: int) -> tuple[torch.Tensor, torch.Tensor]:
    """Real param-vector structure mapped through a fixed random linear teacher -> [n, N_MELS],
    so a working trainer must drive val L1 well below the mean-predictor baseline."""
    x = np.stack(
        [paramvec.targets_to_vector(xd_params.sample(bytes(1024), u)[1]) for u in xd_params.sobol_unit(n, seed)]
    )
    g = torch.Generator().manual_seed(seed)
    xt = torch.from_numpy(x)
    w = torch.randn(paramvec.VEC_DIM, schema.N_MELS, generator=g)
    return xt, xt @ w + 0.01 * torch.randn(n, schema.N_MELS, generator=g)


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

    @torch.no_grad()
    def val_l1() -> float:
        model.eval()
        return float(F.l1_loss(model(xva), yva))

    best = val_l1()
    best_state = copy.deepcopy(model.state_dict())
    print(f"val L1 @init: {best:.4f}  (train {len(ti)}, val {len(vi)})")
    for ep in range(1, epochs + 1):
        model.train()
        for b in torch.randperm(len(xtr), generator=torch.Generator().manual_seed(seed + ep)).split(batch):
            opt.zero_grad()
            F.l1_loss(model(xtr[b]), ytr[b]).backward()
            opt.step()
        v = val_l1()
        if v < best:  # lower L1 is better
            best, best_state = v, copy.deepcopy(model.state_dict())
        if ep % max(1, epochs // 10) == 0 or ep == epochs:
            print(f"epoch {ep:>3}: val L1 {v:.4f}")
    model.load_state_dict(best_state)  # restore the best epoch, not the last
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, nargs="+", help="one or more sweep/preset dirs")
    ap.add_argument("--out", type=Path, default=Path("runs/mel_proxy.pt"))
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--arch", choices=["mlp", "transformer"], default="transformer")
    ap.add_argument("--d-token", type=int, default=192)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--hidden", type=int, default=512)
    ap.add_argument("--depth", type=int, default=4)
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="fit a synthetic linear teacher")
    args = ap.parse_args()

    device = _device(args.device)
    cfg = (
        {"hidden": args.hidden, "depth": args.depth}
        if args.arch == "mlp"
        else {"d_token": args.d_token, "layers": args.layers, "heads": args.heads}
    )
    if args.smoke:
        x, y, eval_mask = (*_smoke_data(512, args.seed), None)
    else:
        if not args.data:
            raise SystemExit("--data required (or use --smoke)")
        from training.data.sweep_dataset import load_sweeps

        mels, _emb, params, is_eval = load_sweeps(args.data)
        x, y, eval_mask = params, pooled_mel(mels), is_eval

    model = proxy_model.build_proxy(args.arch, embed_dim=schema.N_MELS, normalize=False, **cfg)
    best = train(
        model, x, y, epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed, eval_mask=eval_mask,
    )
    if args.smoke:
        baseline = float(F.l1_loss(y, y.mean(0, keepdim=True).expand_as(y)))  # mean-predictor
        assert best < 0.8 * baseline, f"smoke: mel proxy didn't beat the mean predictor ({best:.3f} vs {baseline:.3f})"
        print(f"OK: smoke mel proxy val L1 {best:.4f} < 0.8 * mean-predictor {baseline:.4f}")
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {"arch": args.arch, "config": cfg, "embed_dim": schema.N_MELS, "normalize": False,
         "target": "pooled_log_mel", "state_dict": model.state_dict()},
        args.out,
    )
    print(f"saved {args.arch} mel proxy (val L1 {best:.4f}) -> {args.out}")


if __name__ == "__main__":
    main()
