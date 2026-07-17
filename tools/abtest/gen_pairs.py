"""Generate a blind-2AFC batch from the XD diversity-sweep pool to GROW the ground truth that
`training/eval/metric_correlation.py` scores metrics against (goal: push a learned ranking combiner
past CLAP's ~70%). No hardware, no re-render — it selects target/near/far/pitch-conflict triples from
existing renders and SYMLINKS them into the tools/abtest contract (targets.tsv + <card>/audio/000000.wav).

Basis = the patch PARAMETER vector (`paramvec.targets_to_vector`, model-free, non-circular vs every
audio metric incl CLAP). Pitch is handled via the MIDI note, not params; the "timbre" distance used
for conflict pairs zeroes the pitch dims (vco pitch/octave) so it's orthogonal to the note.

    training/.venv/bin/python tools/abtest/gen_pairs.py \
        --manifest /Volumes/Samples/training/xd_diverse/samples.jsonl \
        --pool-audio /Volumes/Samples/training/xd_diverse/audio \
        --out /Volumes/Samples/training/abtest_pairs/sess_00 --n-targets 40 --seed 0
    training/.venv/bin/python tools/abtest/serve.py --tsv <out>/targets.tsv --renders <out> --open
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = "/Users/ava/Developer/minilogue-viewer"
sys.path.insert(0, REPO)

from training import paramvec, schema  # noqa: E402
from training.data.select_diverse import _farthest_point  # noqa: E402

PITCHES = [24, 36, 48, 60, 72]
# Pitch dims in the 117-d vector: continuous vco1/2_pitch (2,4) + discrete one-hot groups
# octave(0)/vco1_octave(3)/vco2_octave(5). Zeroed for the timbre-only (pitch-orthogonal) distance.
_OFFS = np.cumsum([0, *schema.DISCRETE_CARDINALITIES[:-1]]).astype(int)
_PITCH_IDX = [2, 4]
for _g in (0, 3, 5):
    _s = schema.N_CONTINUOUS + int(_OFFS[_g])
    _PITCH_IDX += list(range(_s, _s + schema.DISCRETE_CARDINALITIES[_g]))
_TIMBRE_MASK = np.ones(paramvec.VEC_DIM, dtype=bool)
_TIMBRE_MASK[_PITCH_IDX] = False


def _unit(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", type=Path, default=Path("/Volumes/Samples/training/xd_diverse/samples.jsonl"))
    ap.add_argument("--pool-audio", type=Path, default=Path("/Volumes/Samples/training/xd_diverse/audio"))
    ap.add_argument("--out", type=Path, required=True, help="fresh renders_dir for this session")
    ap.add_argument("--n-targets", type=int, default=40, help="trials in the batch (before repeats)")
    ap.add_argument("--conflict-frac", type=float, default=0.5, help="fraction that are pitch-vs-timbre conflict")
    ap.add_argument("--rms-min", type=float, default=0.01, help="drop renders quieter than this (manifest rms)")
    ap.add_argument("--pitch-shift", type=int, default=24, help="conflict A's note offset from the target (semitones)")
    ap.add_argument("--mode", choices=["phase0", "hard"], default="phase0",
                    help="phase0 = easy/medium/conflict; hard = close (both candidates near the target, "
                         "deployment-like subtle call) + conflict")
    ap.add_argument("--close-k", type=int, default=6,
                    help="hard mode: B is drawn from the target's rank-2..close-k nearest patches")
    ap.add_argument("--repeat-frac", type=float, default=0.2, help="re-emit this fraction as independent _rep trials")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    # --- load pool: per-patch param vector + per-(patch,pitch) render id (non-silent only) ----
    vec_of: dict[int, np.ndarray] = {}
    render: dict[tuple[int, int], int] = {}
    for line in args.manifest.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r["rms"] >= args.rms_min:
            render[(r["patch"], r["pitch"])] = r["id"]
        vec_of.setdefault(r["patch"], paramvec.targets_to_vector(r))

    patches = sorted(vec_of)
    vecs = np.stack([vec_of[p] for p in patches])
    cont = vecs[:, : schema.N_CONTINUOUS]  # z-score continuous so it's commensurate with 0/1 one-hots
    vecs[:, : schema.N_CONTINUOUS] = (cont - cont.mean(0)) / (cont.std(0) + 1e-9)
    full = _unit(vecs)                       # full-param unit vectors (perceptual proximity, all axes)
    timb = _unit(vecs[:, _TIMBRE_MASK])      # pitch-orthogonal (timbre) unit vectors
    P = len(patches)

    def note_ok(pi: int, pitch: int) -> bool:
        return (patches[pi], pitch) in render

    def avail_pitches(pi: int) -> list[int]:
        return [p for p in PITCHES if note_ok(pi, p)]

    def pick_band(d: np.ndarray, lo_q: float, hi_q: float, pitch: int, exclude: set[int]) -> int | None:
        lo, hi = np.quantile(d, lo_q), np.quantile(d, hi_q)
        cand = [j for j in np.argsort(d) if lo <= d[j] <= hi and j not in exclude and note_ok(j, pitch)]
        return int(rng.choice(cand)) if cand else None

    # Maximally-spread targets (broad coverage, not clustered) — reuse the sweep's FPS selector.
    targets = _farthest_point(full, min(args.n_targets * 3, P))

    n_conflict = round(args.conflict_frac * args.n_targets)
    base = ["close"] if args.mode == "hard" else ["easy", "medium"]
    strata = ["conflict"] * n_conflict + base * args.n_targets
    rng.shuffle(strata)

    trials, used_t, si = [], 0, 0
    for t in targets:
        if len(trials) >= args.n_targets:
            break
        stratum = strata[si]
        tp = avail_pitches(int(t))
        if not tp:
            continue
        pit = int(rng.choice(tp))
        dfull = 1.0 - full @ full[t]
        # near = closest non-duplicate patch with a render at the needed note
        near = next((j for j in np.argsort(dfull)[1:] if dfull[j] > 1e-4 and note_ok(j, pit)), None)
        if near is None:
            continue

        if stratum == "conflict":
            alt = pit + args.pitch_shift
            if alt not in PITCHES:
                alt = pit - args.pitch_shift
            if alt not in PITCHES or not note_ok(int(near), alt):
                continue
            dt = 1.0 - timb @ timb[t]                     # timbre-far (pitch-orthogonal), right note
            far = pick_band(dt, 0.85, 1.0, pit, {int(t), int(near)})
            if far is None:
                continue
            a = (patches[near], alt, "timbre")            # right timbre, wrong pitch
            b = (patches[far], pit, "pitch")              # right pitch, wrong timbre
        elif stratum == "close":  # both candidates near the target — subtle, deployment-like call
            window = [j for j in np.argsort(dfull)
                      if dfull[j] > 1e-4 and note_ok(j, pit) and j not in (int(t), int(near))][: args.close_k - 1]
            if not window:
                continue
            far = int(rng.choice(window))
            a = (patches[near], pit, "near")              # rank-1 nearest
            b = (patches[far], pit, "far")                # rank 2..close-k (still near)
        else:
            lo, hi = (0.9, 1.0) if stratum == "easy" else (0.45, 0.6)  # far-band difficulty
            far = pick_band(dfull, lo, hi, pit, {int(t), int(near)})
            if far is None:
                continue
            a = (patches[near], pit, "near")              # decisively closer
            b = (patches[far], pit, "far")

        trials.append({"target": (patches[int(t)], pit), "A": a, "B": b, "stratum": stratum})
        used_t += 1
        si += 1

    # Re-emit a fraction as independent `_rep` trials (distinct target symlink → distinct col0 →
    # serve treats it as a separate trial) for post-hoc intra-rater self-consistency filtering.
    reps = rng.choice(len(trials), size=round(args.repeat_frac * len(trials)), replace=False)
    batch = [(f"t{i:03d}_{tr['stratum']}", tr) for i, tr in enumerate(trials)]
    batch += [(f"t{i:03d}_{trials[i]['stratum']}_rep", trials[i]) for i in sorted(reps)]

    # --- write the abtest contract: targets.tsv + per-card audio symlinks ----------------------
    out = args.out.resolve()
    (out / "targets").mkdir(parents=True, exist_ok=True)
    pool = args.pool_audio.resolve()

    def link(dst: Path, sample_id: int) -> None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.is_symlink() or dst.exists():
            dst.unlink()
        dst.symlink_to(pool / f"{sample_id:06d}.wav")

    rows, side = [], []
    for name, tr in batch:
        (tpatch, tpit), (ap_, apit, atag), (bp, bpit, btag) = tr["target"], tr["A"], tr["B"]
        tgt = out / "targets" / f"{name}.wav"
        link(tgt, render[(tpatch, tpit)])
        link(out / f"{name}__{atag}" / "audio" / "000000.wav", render[(ap_, apit)])
        link(out / f"{name}__{btag}" / "audio" / "000000.wav", render[(bp, bpit)])
        rows += [f"{tgt}\t{tpit}\t{name}__{atag}", f"{tgt}\t{tpit}\t{name}__{btag}"]
        side.append({"trial": name, "stratum": tr["stratum"], "target": [tpatch, tpit],
                     "A": [ap_, apit, atag], "B": [bp, bpit, btag]})

    (out / "targets.tsv").write_text("\n".join(rows) + "\n")
    (out / "pairs.jsonl").write_text("".join(json.dumps(s) + "\n" for s in side))
    n_conf = sum(t["stratum"] == "conflict" for _n, t in batch)
    print(f"wrote {len(batch)} trials ({len(rows)} rows) to {out}\n"
          f"  strata: {n_conf} conflict, {len(batch) - n_conf} {'close' if args.mode == 'hard' else 'easy/medium'} (+repeats); {P} patches in pool\n"
          f"  serve: training/.venv/bin/python tools/abtest/serve.py --tsv {out}/targets.tsv --renders {out} --open")


if __name__ == "__main__":
    main()
