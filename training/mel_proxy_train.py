"""Train a params -> log-mel SPECTRAL proxy: a differentiable stand-in for "render on the XD
-> log-mel", for the Stage-3 spectral-reconstruction objective (encoder -> params -> this
proxy -> mel, compared to the source mel).

Motivation (2026-06-27 hardware eval + listening, see [[preset-finetune-result]],
[[resynth-improvement-research]]): training only through frozen surrogates (params->CLAP and
params->pooled-mel) never compares rendered output to the source, so matches sound wrong
despite good metrics. A faithful params->FULL-mel proxy lets the encoder minimize an actual
rendered-vs-source spectral distance.

  --target full   (default): predict the full log-mel [N_MELS, N_FRAMES] (arch="melspec",
                  transformer param-tower + transposed-conv decoder). The real renderer.
  --target pooled : predict the time-mean log-mel [N_MELS] (a cheap envelope proxy; stepping
                  stone). Output is NOT normalized (raw log-mel) in either case.

Held-out presets (split=="eval") are the val set. `--target full` runs a FIDELITY GATE at the
end (held-out recon L1 + target-vs-recon mel images) — its fidelity caps the Stage-3 objective.

    python -m training.mel_proxy_train --data /Volumes/Samples/training/xd /Volumes/Samples/training/presets /Volumes/Samples/training/presets_new --target full --out runs/melspec_proxy.pt
    python -m training.mel_proxy_train --smoke    # synthetic linear teacher; no data

Requires torch (the `train` extra). Run from the repo root.
"""

from __future__ import annotations

import argparse
import copy
import os
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


def full_mel(mels) -> torch.Tensor:
    """[N, N_MELS, N_FRAMES] log-mel as a float32 tensor (the full-spectrogram target)."""
    return torch.from_numpy(np.asarray(mels).astype(np.float32))


def _smoke_data(n: int, seed: int, target: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Real param-vector structure through a fixed random linear teacher, so a working trainer
    must drive val L1 well below the mean-predictor baseline. Target shape matches `target`."""
    x = np.stack(
        [paramvec.targets_to_vector(xd_params.sample(bytes(1024), u)[1]) for u in xd_params.sobol_unit(n, seed)]
    )
    g = torch.Generator().manual_seed(seed)
    xt = torch.from_numpy(x)
    if target == "full":
        # smooth, param-conditioned mel (low-frequency cosine bases) — fittable by the conv
        # decoder, like real spectra. A per-pixel random map would be (correctly) unfittable.
        nm, nf, kf, kt = schema.N_MELS, schema.N_FRAMES, 5, 4
        bf = torch.cos(torch.outer(torch.arange(kf).float(), torch.linspace(0, 3.14159, nm)))
        bt = torch.cos(torch.outer(torch.arange(kt).float(), torch.linspace(0, 3.14159, nf)))
        freq = (xt @ torch.randn(paramvec.VEC_DIM, kf, generator=g)) @ bf  # [n, nm] smooth
        time = (xt @ torch.randn(paramvec.VEC_DIM, kt, generator=g)) @ bt  # [n, nf] smooth
        return xt, freq.unsqueeze(-1) + time.unsqueeze(1)  # [n, nm, nf]
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


def _dump_mel_images(tgt: np.ndarray, rec: np.ndarray, out_dir: Path) -> None:
    os.makedirs(out_dir, exist_ok=True)
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        vmin, vmax = float(min(tgt.min(), rec.min())), float(max(tgt.max(), rec.max()))
        for i in range(len(tgt)):
            fig, ax = plt.subplots(1, 2, figsize=(8, 3))
            for a, m, title in ((ax[0], tgt[i], "target"), (ax[1], rec[i], "recon")):
                a.imshow(m, origin="lower", aspect="auto", vmin=vmin, vmax=vmax)
                a.set_title(title)
                a.set_xticks([])
                a.set_yticks([])
            fig.savefig(out_dir / f"mel_{i:02d}.png", dpi=80, bbox_inches="tight")
            plt.close(fig)
        print(f"  wrote {len(tgt)} target-vs-recon mel PNGs to {out_dir}")
    except Exception as e:  # matplotlib missing / headless issue -> dump arrays
        np.savez(out_dir / "mels.npz", target=tgt, recon=rec)
        print(f"  matplotlib unavailable ({e!r}); saved arrays to {out_dir / 'mels.npz'}")


def _fidelity_report(model, x, y, eval_mask, device, out_dir: Path, n_images: int = 8) -> None:
    """The Phase-1 GATE: held-out recon L1 (+ per-band) and target-vs-recon mel images."""
    model.eval()
    if eval_mask is not None and bool(eval_mask.any()):
        idx = torch.nonzero(eval_mask, as_tuple=False).flatten()
    else:
        idx = torch.arange(min(256, len(x)))
    with torch.no_grad():
        recon = torch.cat([model(x[idx[i : i + 128]].to(device)).cpu() for i in range(0, len(idx), 128)])
    tgt = y[idx]
    l1 = float(F.l1_loss(recon, tgt))
    base = float(F.l1_loss(tgt, tgt.mean(0, keepdim=True).expand_as(tgt)))  # mean-mel predictor
    nb = schema.N_MELS // 4
    bands = [round(float(F.l1_loss(recon[:, b * nb : (b + 1) * nb], tgt[:, b * nb : (b + 1) * nb])), 3) for b in range(4)]
    print(
        f"FIDELITY GATE: held-out recon L1 {l1:.4f}  (mean-predictor baseline {base:.4f}); "
        f"mel-band L1 [low..high] {bands}  (n={len(idx)})"
    )
    sel = idx[torch.linspace(0, len(idx) - 1, min(n_images, len(idx))).long()]
    with torch.no_grad():
        rec = model(x[sel].to(device)).cpu().numpy()
    _dump_mel_images(y[sel].numpy(), rec, out_dir)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, nargs="+", help="one or more sweep/preset dirs")
    ap.add_argument("--out", type=Path, default=Path("runs/melspec_proxy.pt"))
    ap.add_argument("--target", choices=["pooled", "full"], default="full",
                    help="full = params->[N_MELS,N_FRAMES] (melspec); pooled = ->[N_MELS] envelope")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--arch", choices=["mlp", "transformer"], default="transformer", help="pooled only")
    ap.add_argument("--d-token", type=int, default=192)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--dec-ch", type=int, default=64, help="melspec decoder base channels")
    ap.add_argument("--hidden", type=int, default=512, help="pooled mlp only")
    ap.add_argument("--depth", type=int, default=4, help="pooled mlp only")
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="fit a synthetic linear teacher")
    args = ap.parse_args()

    device = _device(args.device)
    if args.smoke:
        x, y, eval_mask = (*_smoke_data(512, args.seed, args.target), None)
    else:
        if not args.data:
            raise SystemExit("--data required (or use --smoke)")
        from training.data.sweep_dataset import load_sweeps

        mels, _emb, params, is_eval = load_sweeps(args.data)
        x, eval_mask = params, is_eval
        y = full_mel(mels) if args.target == "full" else pooled_mel(mels)

    if args.target == "full":
        cfg = {"d_token": args.d_token, "layers": args.layers, "heads": args.heads, "dec_ch": args.dec_ch}
        model = proxy_model.build_proxy("melspec", **cfg)
    else:
        cfg = {"hidden": args.hidden, "depth": args.depth} if args.arch == "mlp" else {"d_token": args.d_token, "layers": args.layers, "heads": args.heads}
        model = proxy_model.build_proxy(args.arch, embed_dim=schema.N_MELS, normalize=False, **cfg)

    best = train(
        model, x, y, epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed, eval_mask=eval_mask,
    )
    if args.smoke:
        baseline = float(F.l1_loss(y, y.mean(0, keepdim=True).expand_as(y)))  # mean-predictor
        assert best < 0.8 * baseline, f"smoke: {args.target} mel proxy didn't beat the mean predictor ({best:.3f} vs {baseline:.3f})"
        print(f"OK: smoke {args.target} mel proxy val L1 {best:.4f} < 0.8 * mean-predictor {baseline:.4f}")
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    arch = "melspec" if args.target == "full" else args.arch
    torch.save(
        {"arch": arch, "config": cfg, "embed_dim": schema.N_MELS, "normalize": False,
         "target": ("full_log_mel" if args.target == "full" else "pooled_log_mel"),
         "state_dict": model.state_dict()},
        args.out,
    )
    print(f"saved {arch} proxy (val L1 {best:.4f}) -> {args.out}")
    if args.target == "full":
        _fidelity_report(model, x, y, eval_mask, device, args.out.parent / "melspec_fidelity")


if __name__ == "__main__":
    main()
