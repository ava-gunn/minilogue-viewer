"""Train the sound-matching encoder. Pretrain and fine-tune are the same loop over
different datasets (Surge XT / XD recordings, Phase 4); `--smoke` runs it on a synthetic
dataset to exercise forward/loss/backward before real data exists.

    python -m training.train --smoke --steps 200 --out training/checkpoints/smoke.pt

Run from the repo root. Writes a state_dict that `export.py --checkpoint` turns into ONNX.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset

from training.data.dataset import SyntheticDataset
from training.losses import multihead_loss
from training.model.encoder import SoundMatchEncoder

_REPO = Path(__file__).resolve().parent.parent


def train(
    dataset: Dataset,
    *,
    steps: int = 200,
    batch_size: int = 16,
    lr: float = 1e-3,
    device: str = "cpu",
    log_every: int = 20,
) -> tuple[SoundMatchEncoder, dict[str, float]]:
    model = SoundMatchEncoder().to(device)
    model.train()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True, drop_last=True)

    step = 0
    last: dict[str, float] = {}
    while step < steps:
        for mel, cont_t, disc_t, bool_t in loader:
            pred = model(mel.to(device))
            loss, parts = multihead_loss(
                pred, (cont_t.to(device), disc_t.to(device), bool_t.to(device))
            )
            opt.zero_grad()
            loss.backward()
            opt.step()

            step += 1
            last = {**parts, "total": loss.item()}
            if step == 1 or step % log_every == 0:
                print(
                    f"step {step:4d}  total {last['total']:.4f}  "
                    f"cont {parts['continuous']:.4f}  "
                    f"disc {parts['discrete']:.4f}  bool {parts['boolean']:.4f}"
                )
            if step >= steps:
                break
    return model, last


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--smoke", action="store_true", help="train on a synthetic dataset")
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument(
        "--out", type=Path, default=_REPO / "training" / "checkpoints" / "smoke.pt"
    )
    args = ap.parse_args()

    if not args.smoke:
        raise SystemExit("Real datasets arrive in Phase 4 — use --smoke for now.")

    model, last = train(
        SyntheticDataset(), steps=args.steps, batch_size=args.batch_size, lr=args.lr
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), args.out)
    print(f"final {last}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
