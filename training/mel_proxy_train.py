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
  --target full+clap : two-headed (arch="melclap") — full log-mel + the CLAP embedding [512],
                  joint scale-normalized loss. The Phase-1 proxy for the reconstruction
                  objective (structural mel + perceptual CLAP).
  --target pooled : predict the time-mean log-mel [N_MELS] (a cheap envelope proxy; stepping
                  stone). Output is NOT normalized (raw log-mel) in either case.

Held-out presets (split=="eval") are the val set. `--target full`/`full+clap` runs a FIDELITY
GATE at the end (held-out recon mel-L1 + CLAP cosine + target-vs-recon mel images) — its
fidelity caps the Stage-3 objective.

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
from training.proxy_train import _device, cosine_loss


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
    if target in ("full", "full+clap"):
        # smooth, param-conditioned mel (low-frequency cosine bases) — fittable by the conv
        # decoder, like real spectra. A per-pixel random map would be (correctly) unfittable.
        nm, nf, kf, kt = schema.N_MELS, schema.N_FRAMES, 5, 4
        bf = torch.cos(torch.outer(torch.arange(kf).float(), torch.linspace(0, 3.14159, nm)))
        bt = torch.cos(torch.outer(torch.arange(kt).float(), torch.linspace(0, 3.14159, nf)))
        freq = (xt @ torch.randn(paramvec.VEC_DIM, kf, generator=g)) @ bf  # [n, nm] smooth
        time = (xt @ torch.randn(paramvec.VEC_DIM, kt, generator=g)) @ bt  # [n, nf] smooth
        mel = freq.unsqueeze(-1) + time.unsqueeze(1)  # [n, nm, nf]
        if target == "full":
            return xt, mel
        clap = F.normalize(xt @ torch.randn(paramvec.VEC_DIM, proxy_model.EMBED_DIM, generator=g), dim=-1)
        return xt, (mel, clap)  # two-headed teacher
    w = torch.randn(paramvec.VEC_DIM, schema.N_MELS, generator=g)
    return xt, xt @ w + 0.01 * torch.randn(n, schema.N_MELS, generator=g)


def _to_dev(y, device):
    """Move a target (a tensor, or a tuple of tensors for a multi-head proxy) to device."""
    return tuple(t.to(device) for t in y) if isinstance(y, tuple) else y.to(device)


def _index(y, idx):
    """Index a target (a tensor, or a tuple of tensors) along the batch dim."""
    return tuple(t[idx] for t in y) if isinstance(y, tuple) else y[idx]


def train(model, x, y, *, epochs, batch, lr, val_frac, device, seed, eval_mask=None,
          loss_fn=None, report_fn=None) -> float:
    """y is the target tensor, or a tuple of target tensors for a multi-head proxy. loss_fn(out,
    y_batch) defaults to L1 (so single-head pooled/full are unchanged); report_fn(model, xva,
    yva) -> str is an optional per-epoch breakdown line. Best-checkpoint on the val loss."""
    if loss_fn is None:
        loss_fn = lambda out, yb: F.l1_loss(out, yb)
    if eval_mask is not None and bool(eval_mask.any()):  # held-out presets are the val set
        vi = torch.nonzero(eval_mask, as_tuple=False).flatten()
        ti = torch.nonzero(~eval_mask, as_tuple=False).flatten()
    else:
        perm = torch.randperm(len(x), generator=torch.Generator().manual_seed(seed))
        n_val = max(1, int(len(x) * val_frac))
        vi, ti = perm[:n_val], perm[n_val:]
    xtr, xva = x[ti].to(device), x[vi].to(device)
    ytr, yva = _to_dev(_index(y, ti), device), _to_dev(_index(y, vi), device)
    model = model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr)

    @torch.no_grad()
    def val_loss() -> float:
        model.eval()
        return float(loss_fn(model(xva), yva))

    @torch.no_grad()
    def extra() -> str:
        if report_fn is None:
            return ""
        model.eval()
        return "  " + report_fn(model, xva, yva)

    best = val_loss()
    best_state = copy.deepcopy(model.state_dict())
    print(f"val loss @init: {best:.4f}{extra()}  (train {len(ti)}, val {len(vi)})")
    for ep in range(1, epochs + 1):
        model.train()
        for b in torch.randperm(len(xtr), generator=torch.Generator().manual_seed(seed + ep)).split(batch):
            opt.zero_grad()
            loss_fn(model(xtr[b]), _index(ytr, b)).backward()
            opt.step()
        v = val_loss()
        if v < best:  # lower loss is better
            best, best_state = v, copy.deepcopy(model.state_dict())
        if ep % max(1, epochs // 10) == 0 or ep == epochs:
            print(f"epoch {ep:>3}: val loss {v:.4f}{extra()}")
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
    """The Phase-1 GATE: held-out recon mel-L1 (+ per-band), plus CLAP cosine for the two-headed
    proxy, and target-vs-recon mel images. y is the mel target, or (mel, clap) for melclap."""
    model.eval()
    if eval_mask is not None and bool(eval_mask.any()):
        idx = torch.nonzero(eval_mask, as_tuple=False).flatten()
    else:
        idx = torch.arange(min(256, len(x)))
    mel_y, clap_y = (y[0], y[1]) if isinstance(y, tuple) else (y, None)
    mels, claps = [], []
    with torch.no_grad():
        for i in range(0, len(idx), 128):
            out = model(x[idx[i : i + 128]].to(device))
            mels.append((out["mel"] if isinstance(out, dict) else out).cpu())
            if isinstance(out, dict):
                claps.append(out["clap"].cpu())
    recon, tgt = torch.cat(mels), mel_y[idx]
    l1 = float(F.l1_loss(recon, tgt))
    base = float(F.l1_loss(tgt, tgt.mean(0, keepdim=True).expand_as(tgt)))  # mean-mel predictor
    nb = schema.N_MELS // 4
    bands = [round(float(F.l1_loss(recon[:, b * nb : (b + 1) * nb], tgt[:, b * nb : (b + 1) * nb])), 3) for b in range(4)]
    msg = (f"FIDELITY GATE: held-out recon mel-L1 {l1:.4f}  (mean-predictor baseline {base:.4f}); "
           f"mel-band L1 [low..high] {bands}")
    if claps:
        msg += f";  CLAP cosine {float((torch.cat(claps) * clap_y[idx]).sum(-1).mean()):.4f}"
    print(msg + f"  (n={len(idx)})")
    sel = idx[torch.linspace(0, len(idx) - 1, min(n_images, len(idx))).long()]
    with torch.no_grad():
        out = model(x[sel].to(device))
        rec = (out["mel"] if isinstance(out, dict) else out).cpu().numpy()
    _dump_mel_images(mel_y[sel].numpy(), rec, out_dir)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, nargs="+", help="one or more sweep/preset dirs")
    ap.add_argument("--out", type=Path, default=Path("runs/melspec_proxy.pt"))
    ap.add_argument("--target", choices=["pooled", "full", "full+clap"], default="full",
                    help="full = params->[N_MELS,N_FRAMES] (melspec); full+clap = two-headed "
                         "(melclap) mel + CLAP; pooled = ->[N_MELS] envelope")
    ap.add_argument("--mel-weight", type=float, default=1.0, help="full+clap: mel-L1 term weight (scale-normalized)")
    ap.add_argument("--clap-weight", type=float, default=1.0, help="full+clap: CLAP cosine-distance term weight")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--arch", choices=["mlp", "transformer"], default="transformer", help="pooled only")
    ap.add_argument("--d-token", type=int, default=192)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--dec-ch", type=int, default=64, help="melspec/conv decoder base channels")
    ap.add_argument("--mel-decoder", choices=["conv", "temporal"], default="temporal",
                    help="full+clap mel head: temporal (per-frame self-attention, default) or conv (transposed-conv)")
    ap.add_argument("--dec-layers", type=int, default=2, help="temporal mel-decoder transformer layers")
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

        mels, emb, params, is_eval = load_sweeps(args.data)
        x, eval_mask = params, is_eval
        if args.target == "full+clap":
            y = (full_mel(mels), emb)  # emb is already L2-normalized
        else:
            y = full_mel(mels) if args.target == "full" else pooled_mel(mels)

    if args.target == "full+clap":
        cfg = {"d_token": args.d_token, "layers": args.layers, "heads": args.heads, "dec_ch": args.dec_ch,
               "mel_decoder": args.mel_decoder, "dec_layers": args.dec_layers}
        model = proxy_model.build_proxy("melclap", embed_dim=proxy_model.EMBED_DIM, normalize=True, **cfg)
    elif args.target == "full":
        cfg = {"d_token": args.d_token, "layers": args.layers, "heads": args.heads, "dec_ch": args.dec_ch}
        model = proxy_model.build_proxy("melspec", **cfg)
    else:
        cfg = {"hidden": args.hidden, "depth": args.depth} if args.arch == "mlp" else {"d_token": args.d_token, "layers": args.layers, "heads": args.heads}
        model = proxy_model.build_proxy(args.arch, embed_dim=schema.N_MELS, normalize=False, **cfg)

    loss_fn = report_fn = None
    if args.target == "full+clap":
        mel_t = y[0]
        # scale-normalize so the mel-L1 term (~mel_ref) is commensurate with cosine in [0, 2]
        mel_ref = max(float(F.l1_loss(mel_t, mel_t.mean(0, keepdim=True).expand_as(mel_t))), 1e-6)
        aw, bw = args.mel_weight, args.clap_weight

        def loss_fn(out, yb):
            mt, ct = yb
            return aw * F.l1_loss(out["mel"], mt) / mel_ref + bw * cosine_loss(out["clap"], ct)

        def report_fn(m, xv, yv):
            o = m(xv)
            return (f"[mel-L1 {float(F.l1_loss(o['mel'], yv[0])):.3f}  "
                    f"CLAP-cos {float((o['clap'] * yv[1]).sum(-1).mean()):.3f}]")

    best = train(
        model, x, y, epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed, eval_mask=eval_mask,
        loss_fn=loss_fn, report_fn=report_fn,
    )
    if args.smoke:
        if args.target == "full+clap":
            mt, ct = y
            mean = {"mel": mt.mean(0, keepdim=True).expand_as(mt),
                    "clap": F.normalize(ct.mean(0, keepdim=True), dim=-1).expand_as(ct)}
            baseline = float(loss_fn(mean, y))  # joint mean-predictor, same loss as training
        else:
            baseline = float(F.l1_loss(y, y.mean(0, keepdim=True).expand_as(y)))  # mean-predictor
        assert best < 0.8 * baseline, f"smoke: {args.target} proxy didn't beat the mean predictor ({best:.3f} vs {baseline:.3f})"
        print(f"OK: smoke {args.target} proxy val loss {best:.4f} < 0.8 * mean-predictor {baseline:.4f}")
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.target == "full+clap":
        meta = {"arch": "melclap", "embed_dim": proxy_model.EMBED_DIM, "normalize": True, "target": "full_log_mel+clap"}
    elif args.target == "full":
        meta = {"arch": "melspec", "embed_dim": schema.N_MELS, "normalize": False, "target": "full_log_mel"}
    else:
        meta = {"arch": args.arch, "embed_dim": schema.N_MELS, "normalize": False, "target": "pooled_log_mel"}
    torch.save({**meta, "config": cfg, "state_dict": model.state_dict()}, args.out)
    print(f"saved {meta['arch']} proxy (val loss {best:.4f}) -> {args.out}")
    if args.target in ("full", "full+clap"):
        sub = "melclap_fidelity" if args.target == "full+clap" else "melspec_fidelity"
        _fidelity_report(model, x, y, eval_mask, device, args.out.parent / sub)


if __name__ == "__main__":
    main()
