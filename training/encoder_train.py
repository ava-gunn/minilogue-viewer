"""End-to-end encoder training through the frozen proxy (Stage 3). No hardware.

For each swept clip:  mel(audio[:1s]) -> SoundMatchEncoder -> (continuous, discrete logits,
boolean) -> [bridge] -> frozen ParamProxy -> embedding,  loss = cosine vs the clip's CLAP
embedding. The encoder learns audio -> params such that the proxy reproduces the perceptual
embedding.

The discrete heads are argmax-decoded at inference (non-differentiable), so during training
the bridge feeds the proxy a per-group *softmax* (a soft one-hot, temperature-annealable);
ONNX export keeps the hard argmax. That soft one-hot is out-of-distribution for the proxy
(trained on hard one-hots), so the embedding loss gives the categorical heads a weak gradient
— hence a supervised parameter loss (L1 on continuous + per-group CE on discrete + BCE on
boolean, from the sweep's ground-truth params), split by type (Combes et al. Mix/Switch): the
continuous term follows the schedule (Switch decays it so the embedding loss owns continuous
values late, since over-fitting them sank direct regression), while the categorical term
(discrete CE + boolean BCE) stays on throughout. Saves a raw encoder state_dict that
`training.export --checkpoint` consumes.

    python -m training.encoder_train --data /Volumes/Samples/training/xd --proxy runs/proxy.pt --out runs/encoder.pt
    python -m training.encoder_train --smoke    # no data/proxy file: exercise the gradient path

Requires torch (the `train` extra). Run from the repo root.
"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from training import schema, xd_params
from training.model import proxy as proxy_model
from training.model.encoder import SoundMatchEncoder
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


def _load_proxy(path: Path, device: torch.device) -> torch.nn.Module:
    ckpt = torch.load(path, map_location=device)
    arch = ckpt.get("arch", "mlp")  # tolerate older mlp-only checkpoints
    cfg = ckpt.get("config") or {"hidden": ckpt.get("hidden", 512), "depth": ckpt.get("depth", 4)}
    proxy = proxy_model.build_proxy(arch, embed_dim=ckpt["embed_dim"], **cfg)
    proxy.load_state_dict(ckpt["state_dict"])
    proxy.eval().requires_grad_(False)
    return proxy.to(device)


def _param_loss(cont, disc_logits, boolean, true_cont, true_disc, true_bool):
    """Supervised parameter loss (Combes et al.), split by type for separate scheduling:
    returns (continuous_l1, categorical_loss), where categorical = mean per-group cross-entropy
    on discrete logits + BCE on boolean. Both come from the Sobol sweep's exact ground-truth
    params; the split lets the continuous term decay while the categorical term persists."""
    ce = disc_logits.new_zeros(())
    off = 0
    for g, card in enumerate(schema.DISCRETE_CARDINALITIES):
        ce = ce + F.cross_entropy(disc_logits[:, off : off + card], true_disc[:, g])
        off += card
    ce = ce / len(schema.DISCRETE_CARDINALITIES)
    return F.l1_loss(cont, true_cont), ce + F.binary_cross_entropy(boolean, true_bool)


def train(
    encoder, proxy, mels, emb, params, *,
    temp, temp_final, schedule, aux_weight, disc_weight=None, embed_warmup, epochs, batch, lr,
    val_frac, device, seed, is_eval=None,
) -> float:
    n = len(mels)
    if is_eval is not None and bool(is_eval.any()):  # held-out presets are the val set
        val_idx = [i for i in range(n) if is_eval[i]]
        tr_idx = [i for i in range(n) if not is_eval[i]]
    else:
        perm = torch.randperm(n, generator=torch.Generator().manual_seed(seed)).tolist()
        n_val = int(n * val_frac)
        val_idx, tr_idx = perm[:n_val], perm[n_val:]
    emb, params = emb.to(device), params.to(device)
    encoder, proxy = encoder.to(device), proxy.to(device)
    opt = torch.optim.AdamW(encoder.parameters(), lr=lr)

    # Ground-truth heads (recovered from the 117-d one-hot vector) for the parameter loss.
    nc, td = schema.N_CONTINUOUS, schema.TOTAL_DISCRETE
    true_cont, true_bool = params[:, :nc], params[:, nc + td :]
    slices, off = [], 0
    for card in schema.DISCRETE_CARDINALITIES:
        slices.append((off, off + card)); off += card
    true_disc = torch.stack([params[:, nc + a : nc + b].argmax(1) for a, b in slices], dim=1)

    def melbatch(idx: list[int]) -> torch.Tensor:
        return torch.from_numpy(np.asarray(mels[idx])).unsqueeze(1).to(device)

    @torch.no_grad()
    def cosine_on(idx: list[int], temperature: float) -> float:
        encoder.eval()
        c, d, b = encoder(melbatch(idx))
        return float((proxy(proxy_input(c, d, b, temperature)) * emb[idx]).sum(-1).mean())

    dw = aux_weight if disc_weight is None else disc_weight
    report_idx = val_idx if val_idx else tr_idx[: min(512, len(tr_idx))]
    label = "val" if val_idx else "train"
    print(f"{label} cosine @init: {cosine_on(report_idx, temp):.4f}  (train {len(tr_idx)}, "
          f"val {len(val_idx)}, schedule={schedule}, aux_cont={aux_weight}, aux_cat={dw})")
    best = -1.0
    best_state = copy.deepcopy(encoder.state_dict())
    for ep in range(1, epochs + 1):
        prog = (ep - 1) / max(1, epochs - 1)
        t = temp + (temp_final - temp) * prog
        # Param-loss-first -> embedding (Combes et al. Mix/Switch), split by type: ramp the
        # embedding loss in over the warmup; the continuous L1 follows the schedule (Switch
        # decays it to 0, Mix keeps it), while the categorical term (discrete CE + boolean BCE)
        # stays on throughout — the bridge's soft one-hots give it a weak embedding gradient.
        if schedule == "none":
            ew, pw_cont, pw_cat = 1.0, 0.0, 0.0
        else:
            ew = min(1.0, prog / embed_warmup) if embed_warmup > 0 else 1.0
            pw_cont = aux_weight * (1.0 - prog) if schedule == "switch" else aux_weight
            pw_cat = dw
        encoder.train()
        order = torch.randperm(len(tr_idx), generator=torch.Generator().manual_seed(seed + ep))
        for b in order.split(batch):
            idx = [tr_idx[i] for i in b.tolist()]
            opt.zero_grad()
            c, d, bo = encoder(melbatch(idx))
            loss = bo.new_zeros(())
            if ew:
                loss = loss + ew * cosine_loss(proxy(proxy_input(c, d, bo, t)), emb[idx])
            if pw_cont or pw_cat:
                cont_l, cat_l = _param_loss(c, d, bo, true_cont[idx], true_disc[idx], true_bool[idx])
                loss = loss + pw_cont * cont_l + pw_cat * cat_l
            loss.backward()
            opt.step()
        v = cosine_on(report_idx, temp_final)
        if v > best:
            best, best_state = v, copy.deepcopy(encoder.state_dict())
        if ep % max(1, epochs // 10) == 0 or ep == epochs:
            print(f"epoch {ep:>3}: {label} cosine {v:.4f}  (ew={ew:.2f} pc={pw_cont:.2f} pk={pw_cat:.2f})")
    encoder.load_state_dict(best_state)  # restore the best epoch, not the last
    return best


def _smoke(args) -> None:
    device = torch.device("cpu")
    proxy = proxy_model.ParamProxy().to(device).eval().requires_grad_(False)
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
        temp=1.0, temp_final=1.0, schedule="none", aux_weight=0.0, embed_warmup=0.33,
        epochs=args.epochs, batch=32, lr=1e-3, val_frac=0.0, device=device, seed=args.seed,
    )
    assert best > init + 0.04, f"smoke: no learning through the proxy (init {init:.3f} -> best {best:.3f})"
    print(f"OK: smoke encoder cosine {init:.4f} -> {best:.4f} through the frozen proxy")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, nargs="+", help="one or more dirs (sweep + rendered presets)")
    ap.add_argument("--proxy", type=Path, help="trained proxy checkpoint (runs/proxy.pt)")
    ap.add_argument("--init", type=Path, help="warm-start encoder state_dict to finetune from")
    ap.add_argument("--out", type=Path, default=Path("runs/encoder.pt"))
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--temperature", type=float, default=1.0, help="discrete softmax temp at epoch 1")
    ap.add_argument("--temperature-final", type=float, default=None, help="anneal target (default: no anneal)")
    ap.add_argument("--schedule", choices=["none", "mix", "switch"], default="mix",
                    help="continuous param->embedding schedule (Combes et al.): mix keeps continuous L1 late, "
                         "switch decays it to 0; the categorical term (--disc-weight) persists either way")
    ap.add_argument("--aux-weight", type=float, default=1.0,
                    help="continuous-L1 param-loss weight (0 = no continuous supervision); follows --schedule")
    ap.add_argument("--disc-weight", type=float, default=None,
                    help="categorical (discrete CE + boolean BCE) loss weight; stays on across the schedule "
                         "(default: same as --aux-weight). Unlike --aux-weight it does NOT decay under switch")
    ap.add_argument("--embed-warmup", type=float, default=0.33, help="fraction of training to ramp embedding loss 0->1")
    ap.add_argument("--device", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="fit random mels through a frozen random proxy")
    args = ap.parse_args()

    if args.smoke:
        _smoke(args)
        return
    if not args.data or not args.proxy:
        raise SystemExit("--data and --proxy are required (or use --smoke)")

    from training.data.sweep_dataset import load_sweeps

    device = _device(args.device)
    mels, emb, params, is_eval = load_sweeps(args.data)
    encoder = SoundMatchEncoder()
    if args.init:  # finetune: warm-start from the synthetic-pretrained encoder
        encoder.load_state_dict(torch.load(args.init, map_location="cpu"))
        print(f"warm-started from {args.init}")
    best = train(
        encoder, _load_proxy(args.proxy, device), mels, emb, params,
        temp=args.temperature, temp_final=args.temperature_final or args.temperature,
        schedule=args.schedule, aux_weight=args.aux_weight, disc_weight=args.disc_weight,
        embed_warmup=args.embed_warmup, epochs=args.epochs, batch=args.batch, lr=args.lr,
        val_frac=args.val_frac, device=device, seed=args.seed, is_eval=is_eval,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(encoder.state_dict(), args.out)  # raw state_dict -> training.export --checkpoint
    print(f"saved encoder (val cosine {best:.4f}) -> {args.out}")


if __name__ == "__main__":
    main()
