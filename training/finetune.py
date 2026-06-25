"""Fine-tune the XD multi-head on real recordings, warm-starting from the Surge-pretrained
backbone.

    python -m training.finetune --data /Volumes/Samples/training/xd --epochs 60
    python -m training.finetune --data ... --init scratch   # baseline for comparison

Reports per-head validation metrics — continuous L1 (vs 0.25 constant baseline), discrete
accuracy, boolean accuracy — and checkpoints the best full model for ONNX export.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch.utils.data import (
    ConcatDataset,
    DataLoader,
    WeightedRandomSampler,
    random_split,
)

from training import audibility, schema
from training.data.xd_dataset import XdDataset
from training.losses import multihead_loss
from training.model.encoder import SoundMatchEncoder

_REPO = Path(__file__).resolve().parent.parent
_DISCRETE_SLICES: list[tuple[int, int]] = []
_o = 0
for _c in schema.DISCRETE_CARDINALITIES:
    _DISCRETE_SLICES.append((_o, _c))
    _o += _c


def _pick_device(arg: str | None) -> str:
    if arg:
        return arg
    return "mps" if torch.backends.mps.is_available() else "cpu"


def _train_epoch(model, loader, device, opt) -> None:
    model.train()
    for mel, cont, disc, boolean in loader:
        cont, disc, boolean = cont.to(device), disc.to(device), boolean.to(device)
        pred = model(mel.to(device))
        loss, _ = multihead_loss(
            pred, (cont, disc, boolean), masks=audibility.weights(cont)
        )
        opt.zero_grad()
        loss.backward()
        opt.step()


@torch.no_grad()
def evaluate(model, loader, device) -> dict[str, float]:
    model.eval()
    n = batches = 0
    total_loss = cont_l1 = bool_correct = disc_correct = 0.0
    cont_w_num = cont_w_den = 0.0
    for mel, cont, disc, boolean in loader:
        cont, disc, boolean = cont.to(device), disc.to(device), boolean.to(device)
        cp, dp, bp = model(mel.to(device))
        masks = audibility.weights(cont)
        loss, _ = multihead_loss((cp, dp, bp), (cont, disc, boolean), masks=masks)
        total_loss += loss.item()
        batches += 1
        n += mel.shape[0]
        abs_err = (cp - cont).abs()
        cont_l1 += abs_err.sum().item()
        cont_w_num += (masks[0] * abs_err).sum().item()
        cont_w_den += masks[0].sum().item()
        bool_correct += ((bp > 0.5).float() == boolean).float().sum().item()
        for g, (off, card) in enumerate(_DISCRETE_SLICES):
            disc_correct += (dp[:, off : off + card].argmax(1) == disc[:, g]).float().sum().item()
    return {
        "loss": total_loss / batches,
        "cont_l1": cont_l1 / (n * schema.N_CONTINUOUS),
        "cont_l1_audible": cont_w_num / cont_w_den,
        "disc_acc": disc_correct / (n * len(_DISCRETE_SLICES)),
        "bool_acc": bool_correct / (n * schema.N_BOOLEAN),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument(
        "--contrib",
        type=Path,
        help="extra pseudo-labeled split (training/data/pull_contributions.py); "
        "mixed into training only, down-weighted",
    )
    ap.add_argument("--contrib-weight", type=float, default=0.3)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--init", choices=["transfer", "scratch"], default="transfer")
    ap.add_argument("--backbone", type=Path, default=_REPO / "training" / "checkpoints" / "backbone.pt")
    ap.add_argument("--out", type=Path, default=_REPO / "training" / "checkpoints" / "xd_model.pt")
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    device = _pick_device(args.device)
    dataset = XdDataset(args.data)
    n_val = int(len(dataset) * args.val_frac)
    train_ds, val_ds = random_split(
        dataset, [len(dataset) - n_val, n_val], generator=torch.Generator().manual_seed(0)
    )

    # Pseudo-labeled contributions join training only (val stays pure hardware ground truth)
    # and are down-weighted via a sampler so they nudge rather than dominate.
    if args.contrib:
        contrib_ds = XdDataset(args.contrib)
        weights = [1.0] * len(train_ds) + [args.contrib_weight] * len(contrib_ds)
        train_ds = ConcatDataset([train_ds, contrib_ds])
        sampler = WeightedRandomSampler(weights, num_samples=len(train_ds), replacement=True)
        train_dl = DataLoader(
            train_ds, batch_size=args.batch_size, sampler=sampler, drop_last=True
        )
        print(f"+ {len(contrib_ds)} pseudo-labeled contrib samples (weight {args.contrib_weight})")
    else:
        train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, drop_last=True)
    val_dl = DataLoader(val_ds, batch_size=args.batch_size)

    model = SoundMatchEncoder().to(device)
    if args.init == "transfer":
        model.backbone.load_state_dict(torch.load(args.backbone, map_location=device))
        print(f"transferred pretrained backbone from {args.backbone.name}")
    else:
        print("from scratch (no transfer)")
    print(f"device {device} | {len(train_ds)} train / {n_val} val | init={args.init}")

    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    best = float("inf")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        _train_epoch(model, train_dl, device, opt)
        m = evaluate(model, val_dl, device)
        flag = ""
        if m["loss"] < best and args.init == "transfer":
            best = m["loss"]
            tmp = args.out.with_name(args.out.name + ".tmp")
            torch.save(model.state_dict(), tmp)
            tmp.replace(args.out)  # atomic: never leave a half-written checkpoint
            flag = "  *saved"
        if epoch == 1 or epoch % 10 == 0 or epoch == args.epochs:
            print(
                f"epoch {epoch:3d}/{args.epochs}  loss {m['loss']:.4f}  "
                f"cont_l1 {m['cont_l1']:.4f} (audible {m['cont_l1_audible']:.4f})  "
                f"disc_acc {m['disc_acc']:.3f}  bool_acc {m['bool_acc']:.3f}{flag}"
            )

    final = evaluate(model, val_dl, device)
    print(
        f"FINAL [{args.init}]  cont_l1 {final['cont_l1']:.4f}  "
        f"cont_l1_audible {final['cont_l1_audible']:.4f}  "
        f"disc_acc {final['disc_acc']:.3f}  bool_acc {final['bool_acc']:.3f}"
    )
    cont_named, disc_named = _breakdown(model, val_dl, device)
    print("continuous L1 (best-learned first; 0.25 = no better than guessing):")
    for name, l1 in cont_named[:10]:
        print(f"  {l1:.3f}  {name}")
    print("discrete accuracy (best first):")
    for name, acc in disc_named[:10]:
        print(f"  {acc:.2f}  {name}")


@torch.no_grad()
def _breakdown(model, loader, device):
    model.eval()
    cont_err = torch.zeros(schema.N_CONTINUOUS)
    disc_correct = [0.0] * len(_DISCRETE_SLICES)
    n = 0
    for mel, cont, disc, _boolean in loader:
        cp, dp, _bp = model(mel.to(device))
        cont_err += (cp.cpu() - cont).abs().sum(0)
        n += mel.shape[0]
        for g, (off, card) in enumerate(_DISCRETE_SLICES):
            disc_correct[g] += (dp[:, off : off + card].argmax(1).cpu() == disc[:, g]).sum().item()
    cont_named = sorted(
        zip([p["id"] for p in schema.CONTINUOUS], (cont_err / n).tolist()), key=lambda kv: kv[1]
    )
    disc_named = sorted(
        zip([p["id"] for p in schema.DISCRETE], [c / n for c in disc_correct]),
        key=lambda kv: -kv[1],
    )
    return cont_named, disc_named


if __name__ == "__main__":
    main()
