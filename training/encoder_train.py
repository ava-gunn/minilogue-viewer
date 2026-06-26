"""End-to-end encoder training through the frozen proxy (Stage 3). No hardware.

For each swept clip:  mel(audio[:1s]) -> SoundMatchEncoder -> (continuous, discrete logits,
boolean) -> [bridge] -> frozen ParamProxy -> embedding,  loss = cosine vs the clip's CLAP
embedding. The encoder learns audio -> params such that the proxy reproduces the perceptual
embedding.

The discrete heads are argmax-decoded at inference (non-differentiable), so during training
the bridge feeds the proxy a per-group *softmax* (a soft one-hot, temperature-annealable);
ONNX export keeps the hard argmax. An optional auxiliary loss (MSE of the bridged vector vs
the clip's true param vector, --aux-weight, default 0) can pull the heads toward the known
ground truth. Saves a raw encoder state_dict that `training.export --checkpoint` consumes.

    python -m training.encoder_train --data /Volumes/Samples/training/xd --proxy runs/proxy.pt --out runs/encoder.pt
    python -m training.encoder_train --smoke    # no data/proxy file: exercise the gradient path

Requires torch (the `train` extra). Run from the repo root.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training import schema, xd_params
from training.model.encoder import SoundMatchEncoder
from training.model.proxy import ParamProxy
from training.paramvec import targets_to_vector
from training.proxy_train import _device, cosine_loss


def proxy_input(
    continuous: torch.Tensor, discrete_logits: torch.Tensor, boolean: torch.Tensor, temperature: float
) -> torch.Tensor:
    """Encoder heads -> the proxy's VEC_DIM input, matching paramvec's layout: continuous and
    boolean pass through; each discrete group becomes a softmax (soft one-hot) so gradients
    reach the discrete head."""
    groups, off = [], 0
    for card in schema.DISCRETE_CARDINALITIES:
        groups.append(F.softmax(discrete_logits[:, off : off + card] / temperature, dim=-1))
        off += card
    return torch.cat([continuous, torch.cat(groups, dim=-1), boolean], dim=-1)


def _load_proxy(path: Path, device: torch.device) -> ParamProxy:
    ckpt = torch.load(path, map_location=device)
    proxy = ParamProxy(embed_dim=ckpt["embed_dim"], hidden=ckpt["hidden"], depth=ckpt["depth"])
    proxy.load_state_dict(ckpt["state_dict"])
    proxy.eval().requires_grad_(False)
    return proxy.to(device)


def train(
    encoder, proxy, mels, emb, params, *,
    temp, temp_final, aux_weight, epochs, batch, lr, val_frac, device, seed,
) -> float:
    n = len(mels)
    perm = torch.randperm(n, generator=torch.Generator().manual_seed(seed)).tolist()
    n_val = int(n * val_frac)
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    emb, params = emb.to(device), params.to(device)
    encoder, proxy = encoder.to(device), proxy.to(device)
    opt = torch.optim.AdamW(encoder.parameters(), lr=lr)

    def melbatch(idx: list[int]) -> torch.Tensor:
        return torch.from_numpy(np.asarray(mels[idx])).unsqueeze(1).to(device)

    @torch.no_grad()
    def cosine_on(idx: list[int], temperature: float) -> float:
        encoder.eval()
        c, d, b = encoder(melbatch(idx))
        return float((proxy(proxy_input(c, d, b, temperature)) * emb[idx]).sum(-1).mean())

    report_idx = val_idx if val_idx else tr_idx[: min(512, len(tr_idx))]
    label = "val" if val_idx else "train"
    print(f"{label} cosine @init: {cosine_on(report_idx, temp):.4f}  (train {len(tr_idx)}, val {len(val_idx)})")
    best = -1.0
    for ep in range(1, epochs + 1):
        t = temp + (temp_final - temp) * (ep - 1) / max(1, epochs - 1)
        encoder.train()
        order = torch.randperm(len(tr_idx), generator=torch.Generator().manual_seed(seed + ep))
        for b in order.split(batch):
            idx = [tr_idx[i] for i in b.tolist()]
            opt.zero_grad()
            c, d, bo = encoder(melbatch(idx))
            vec = proxy_input(c, d, bo, t)
            loss = cosine_loss(proxy(vec), emb[idx])
            if aux_weight:
                loss = loss + aux_weight * F.mse_loss(vec, params[idx])
            loss.backward()
            opt.step()
        v = cosine_on(report_idx, temp_final)
        best = max(best, v)
        if ep % max(1, epochs // 10) == 0 or ep == epochs:
            print(f"epoch {ep:>3}: {label} cosine {v:.4f}")
    return best


def _smoke(args) -> None:
    device = torch.device("cpu")
    proxy = ParamProxy().to(device).eval().requires_grad_(False)
    n = 64
    true_vec = torch.from_numpy(
        np.stack([targets_to_vector(xd_params.sample(bytes(1024), u)[1]) for u in xd_params.sobol_unit(n, args.seed)])
    )
    target_emb = proxy(true_vec.to(device)).detach()  # the proxy already L2-normalizes
    mels = torch.randn(n, schema.N_MELS, schema.N_FRAMES, generator=torch.Generator().manual_seed(args.seed)).numpy()
    encoder = SoundMatchEncoder().to(device)
    # Baseline before any optimization (a random proxy partly collapses its outputs, so init
    # cosine is high; what matters is that gradients through the proxy then improve it).
    with torch.no_grad():
        c, d, b = encoder(torch.from_numpy(mels).unsqueeze(1).to(device))
        init = float((proxy(proxy_input(c, d, b, 1.0)) * target_emb).sum(-1).mean())
    best = train(
        encoder, proxy, mels, target_emb, true_vec,
        temp=1.0, temp_final=1.0, aux_weight=0.0, epochs=args.epochs, batch=32,
        lr=1e-3, val_frac=0.0, device=device, seed=args.seed,
    )
    assert best > init + 0.04, f"smoke: no learning through the proxy (init {init:.3f} -> best {best:.3f})"
    print(f"OK: smoke encoder cosine {init:.4f} -> {best:.4f} through the frozen proxy")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, help="sweep dir (samples.jsonl + embeddings.npy)")
    ap.add_argument("--proxy", type=Path, help="trained proxy checkpoint (runs/proxy.pt)")
    ap.add_argument("--out", type=Path, default=Path("runs/encoder.pt"))
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--temperature", type=float, default=1.0, help="discrete softmax temp at epoch 1")
    ap.add_argument("--temperature-final", type=float, default=None, help="anneal target (default: no anneal)")
    ap.add_argument("--aux-weight", type=float, default=0.0, help="weight on MSE(bridged vec, true params)")
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="fit random mels through a frozen random proxy")
    args = ap.parse_args()

    if args.smoke:
        _smoke(args)
        return
    if not args.data or not args.proxy:
        raise SystemExit("--data and --proxy are required (or use --smoke)")

    from training.data.sweep_dataset import load_sweep

    device = _device(args.device)
    mels, emb, params = load_sweep(args.data)
    encoder = SoundMatchEncoder()
    best = train(
        encoder, _load_proxy(args.proxy, device), mels, emb, params,
        temp=args.temperature, temp_final=args.temperature_final or args.temperature,
        aux_weight=args.aux_weight, epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(encoder.state_dict(), args.out)  # raw state_dict -> training.export --checkpoint
    print(f"saved encoder (val cosine {best:.4f}) -> {args.out}")


if __name__ == "__main__":
    main()
