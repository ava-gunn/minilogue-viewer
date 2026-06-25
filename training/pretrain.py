"""Pretrain the encoder backbone on Surge XT data (Surge-native head, L1 on the matched
params). Saves the best backbone weights for transfer to the XD fine-tune.

    python -m training.pretrain --data /Volumes/Samples/training/surge \\
        --epochs 40 --out training/checkpoints/backbone.pt

Run from the repo root. A constant-0.5 prediction scores L1 ≈ 0.25; the goal is to fall
well below that (the audio->params map is many-to-one, so it won't reach ~0).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, random_split

from training.data.surge_dataset import FOCUSED_TARGETS, SurgeDataset
from training.model.encoder import SurgePretrainModel

_REPO = Path(__file__).resolve().parent.parent


def _pick_device(arg: str | None) -> str:
    if arg:
        return arg
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _epoch(model, loader, device, opt=None) -> float:
    train = opt is not None
    model.train(train)
    total, batches = 0.0, 0
    with torch.set_grad_enabled(train):
        for mel, target in loader:
            mel, target = mel.to(device), target.to(device)
            loss = F.l1_loss(model(mel), target)
            if train:
                opt.zero_grad()
                loss.backward()
                opt.step()
            total += loss.item()
            batches += 1
    return total / max(batches, 1)


def _per_param_l1(model, loader, device, names: list[str]) -> list[tuple[str, float]]:
    model.eval()
    err = torch.zeros(len(names))
    count = 0
    with torch.no_grad():
        for mel, target in loader:
            pred = model(mel.to(device)).cpu()
            err += (pred - target).abs().sum(0)
            count += target.shape[0]
    return sorted(zip(names, (err / count).tolist()), key=lambda kv: kv[1])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--targets", choices=["focused", "all"], default="focused")
    ap.add_argument("--device", default=None)
    ap.add_argument(
        "--out", type=Path, default=_REPO / "training" / "checkpoints" / "backbone.pt"
    )
    args = ap.parse_args()

    device = _pick_device(args.device)
    target_names = None if args.targets == "all" else FOCUSED_TARGETS
    dataset = SurgeDataset(args.data, target_names=target_names)
    n_val = int(len(dataset) * args.val_frac)
    n_train = len(dataset) - n_val
    train_ds, val_ds = random_split(
        dataset, [n_train, n_val], generator=torch.Generator().manual_seed(0)
    )
    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, drop_last=True)
    val_dl = DataLoader(val_ds, batch_size=args.batch_size)
    print(f"device {device} | {n_train} train / {n_val} val | {dataset.n_params} params")

    model = SurgePretrainModel(dataset.n_params).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)

    best = float("inf")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        train_l1 = _epoch(model, train_dl, device, opt)
        val_l1 = _epoch(model, val_dl, device)
        flag = ""
        if val_l1 < best:
            best = val_l1
            torch.save(model.backbone.state_dict(), args.out)
            flag = "  *saved"
        print(f"epoch {epoch:3d}/{args.epochs}  train_l1 {train_l1:.4f}  val_l1 {val_l1:.4f}{flag}")

    print(f"best val_l1 {best:.4f}  backbone -> {args.out}")
    print("per-param val L1 (low = learnable from audio):")
    for name, l1 in _per_param_l1(model, val_dl, device, dataset.param_names):
        print(f"  {l1:.4f}  {name}")


if __name__ == "__main__":
    main()
