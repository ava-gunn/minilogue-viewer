"""Select a perceptually-diverse subset of XD patches for a hardware sweep — WITHOUT rendering.

Hardware render time is the sweep's binding cost, and uniform Sobol wastes renders on near-silent
or near-duplicate patches. Instead: Sobol-oversample a large pool, use the trained proxy to PREDICT
each patch's CLAP embedding (free, no hardware), then farthest-point (greedy k-center) select N
patches that maximally SPREAD over the XD's perceptual range. Writes the selected unit-vectors as
[N, D] .npy for `xd_record --patches`, and reports the diversity gain + categorical coverage.

    python -m training.data.select_diverse --pool 100000 --n 4000 \
        --proxy /Volumes/Samples/training/runs/proxy.pt \
        --out /Volumes/Samples/training/xd_diverse/selected_units.npy
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import numpy as np
import torch

from training import korg, paramvec, schema, xd_params
from training.eval import infer
from training.model import proxy as proxy_model
from training.proxy_train import _device


def _load_proxy(path: Path, device: torch.device) -> torch.nn.Module:
    ckpt = torch.load(path, map_location=device)
    arch = ckpt.get("arch", "mlp")
    cfg = ckpt.get("config") or {"hidden": ckpt.get("hidden", 512), "depth": ckpt.get("depth", 4)}
    proxy = proxy_model.build_proxy(arch, embed_dim=ckpt["embed_dim"], normalize=ckpt.get("normalize", True), **cfg)
    proxy.load_state_dict(ckpt["state_dict"])
    proxy.eval().requires_grad_(False)
    return proxy.to(device)


def _embed(proxy, vecs: np.ndarray, device, batch: int) -> np.ndarray:
    out = None
    with torch.no_grad():
        for lo in range(0, len(vecs), batch):
            e = proxy(torch.from_numpy(vecs[lo : lo + batch]).to(device))
            e = e["clap"] if isinstance(e, dict) else e
            e = (e / (e.norm(dim=1, keepdim=True) + 1e-8)).cpu().numpy().astype(np.float32)
            if out is None:
                out = np.empty((len(vecs), e.shape[1]), dtype=np.float32)
            out[lo : lo + len(e)] = e
    return out


def _farthest_point(embs: np.ndarray, n: int) -> np.ndarray:
    """Greedy k-center on unit embeddings (cosine distance = 1 - dot). Maximizes min pairwise
    distance = even spread over the perceptual range, avoiding clusters/near-duplicates."""
    mean = embs.mean(0)
    mean /= np.linalg.norm(mean) + 1e-8
    sel = np.empty(n, dtype=np.int64)
    sel[0] = int(np.argmax(1.0 - embs @ mean))  # a boundary point — stable FPS seed
    mind = 1.0 - embs @ embs[sel[0]]
    for k in range(1, n):
        j = int(np.argmax(mind))
        sel[k] = j
        mind = np.minimum(mind, 1.0 - embs @ embs[j])
        if k % 1000 == 0:
            print(f"  fps {k}/{n}")
    return sel


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--proxy", type=Path, default=Path("/Volumes/Samples/training/runs/proxy.pt"))
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    ap.add_argument("--pool", type=int, default=100000, help="Sobol candidate pool size (offline)")
    ap.add_argument("--n", type=int, default=4000, help="patches to select for the sweep")
    ap.add_argument("--seed", type=int, default=1, help="Sobol seed (keep != the main sweep's 0)")
    ap.add_argument("--batch", type=int, default=2048)
    ap.add_argument("--out", type=Path, default=Path("/Volumes/Samples/training/xd_diverse/selected_units.npy"))
    args = ap.parse_args()

    device = _device(None)
    template = korg.extract_prog_bins(args.template)[0]
    print(f"sampling Sobol pool: {args.pool} patches (seed {args.seed})")
    pool_u = xd_params.sobol_unit(args.pool, args.seed)
    vecs = np.empty((args.pool, paramvec.VEC_DIM), dtype=np.float32)
    disc = np.empty((args.pool, len(schema.DISCRETE)), dtype=np.int16)
    for i, u in enumerate(pool_u):
        _pb, t = xd_params.sample(template, u, audible=True)
        vecs[i] = paramvec.targets_to_vector(t)
        disc[i] = t["discrete"]
        if (i + 1) % 25000 == 0:
            print(f"  sampled {i + 1}/{args.pool}")

    print(f"proxy-embedding on {device}")
    embs = _embed(_load_proxy(args.proxy, device), vecs, device, args.batch)
    print(f"farthest-point selecting {args.n} of {args.pool}")
    sel = _farthest_point(embs, args.n)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.save(args.out, pool_u[sel])
    print(f"wrote {args.n} selected unit-vectors -> {args.out}")

    def mean_nn(idx: np.ndarray) -> float:  # mean nearest-neighbor cosine distance (spread)
        sim = embs[idx] @ embs[idx].T
        np.fill_diagonal(sim, -1.0)
        return float((1.0 - sim.max(1)).mean())

    rand = np.random.default_rng(0).choice(args.pool, size=args.n, replace=False)
    print(f"mean nearest-neighbor dist: selected={mean_nn(sel):.4f}  random={mean_nn(rand):.4f}  (higher = more spread)")
    id2pos = {p["id"]: i for i, p in enumerate(schema.DISCRETE)}
    for gid in ("vco1_wave", "vco2_wave", "multi_type"):
        if gid in id2pos:
            print(f"  coverage {gid}: {dict(sorted(Counter(disc[sel, id2pos[gid]].tolist()).items()))}")


if __name__ == "__main__":
    main()
