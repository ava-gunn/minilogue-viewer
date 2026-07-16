"""Selection/eval-metric bake-off against blind 2AFC ground truth (deep-research plan Phase 5).

For every DECISIVE pair in the tools/abtest results, score both XD renders against the target
and check whether a candidate metric ranks the HUMAN-preferred render closer (2AFC agreement),
pooled across all A/Bs that still have their renders + targets.tsv on disk. Candidates: mss_l1
(the shipped refine selector), spectral-centroid + MFCC (arXiv 2603.15905's composite terms),
and CLAP-cosine (the learned embedding the encoder trains against). Higher agreement = better
predictor of the ear. Use it to vet a new metric before trusting it in refine.py / as an eval.

    python -m training.eval.metric_correlation             # incl. CLAP (loads laion-clap)
    python -m training.eval.metric_correlation --no-clap   # spectral only, fast
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import numpy as np

from training.eval import infer, metrics

_REPO = Path(__file__).resolve().parents[2]
SR = infer.SR
CLAP_SR = 48000


def _prep(path: Path) -> np.ndarray:
    return metrics.rms_normalize(infer.load_audio(path))  # 1s fit — matches refine/encoder input


def _mss(t, c):
    return metrics.multiscale_stft_l1(t, c)


def _centroid(t, c):
    import librosa
    return abs(float(librosa.feature.spectral_centroid(y=t, sr=SR).mean())
               - float(librosa.feature.spectral_centroid(y=c, sr=SR).mean()))


def _mfcc(t, c):
    import librosa
    return float(np.mean((librosa.feature.mfcc(y=t, sr=SR, n_mfcc=13)
                          - librosa.feature.mfcc(y=c, sr=SR, n_mfcc=13)) ** 2))


def _f0(t, c):  # cheap pitch term — the axis mss/mfcc are blind to
    return metrics.f0_cents_distance(t, c)


SPECTRAL = {"mss_l1": _mss, "centroid": _centroid, "mfcc": _mfcc, "f0": _f0}


def _clap_load(path: Path) -> np.ndarray:
    import librosa
    y, _ = librosa.load(str(path), sr=CLAP_SR, mono=True)  # full clip at CLAP's native rate
    return metrics.rms_normalize(y.astype(np.float32))


def _cos_dist(a, b) -> float:
    return 1.0 - float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) or 1.0))


def _rate(pairs, scorer):
    w = n = 0
    for _nm, dp, do in pairs:
        a, b = scorer(dp), scorer(do)
        if a != b:
            n += 1; w += (a < b)
    return w, n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--results", default=str(_REPO / "tools/abtest/results/*.json"),
                    help="glob of tools/abtest result JSONs (ground truth)")
    ap.add_argument("--no-clap", action="store_true", help="skip CLAP-cosine (fast, spectral-only)")
    ap.add_argument("--no-cdpam", action="store_true", help="skip CDPAM (needs `pip install cdpam`)")
    args = ap.parse_args()

    embedder = None
    if not args.no_clap:
        print("loading CLAP...")
        from training.data.embed import ClapEmbedder
        embedder = ClapEmbedder()

    cdpam_scorer = None
    if not args.no_cdpam:
        try:
            from training.eval.cdpam_metric import CdpamScorer
            print("loading CDPAM...")
            cdpam_scorer = CdpamScorer()
        except Exception as e:
            print(f"  CDPAM unavailable ({e}) — skipping (pip install cdpam)")

    from scipy.stats import binomtest

    pairs, used = [], []
    for f in sorted(glob.glob(args.results)):
        d = json.load(open(f))
        rdir = Path(d.get("renders_dir", ""))
        tsv = rdir / "targets.tsv"
        if not tsv.exists():
            continue
        card2src = {ln.split("\t")[2]: ln.split("\t")[0] for ln in tsv.read_text().splitlines() if ln.strip()}
        n_dec = 0
        for tr in d.get("trials", []):
            if tr.get("choice") not in ("A", "B") or tr["A"] not in card2src or tr["B"] not in card2src:
                continue
            picked, other = (tr["A"], tr["B"]) if tr["choice"] == "A" else (tr["B"], tr["A"])
            src = card2src[picked]
            pw = rdir / picked / "audio" / "000000.wav"
            ow = rdir / other / "audio" / "000000.wav"
            try:
                tgt, rp, ro = _prep(Path(src)), _prep(pw), _prep(ow)
                dp = {k: fn(tgt, rp) for k, fn in SPECTRAL.items()}
                do = {k: fn(tgt, ro) for k, fn in SPECTRAL.items()}
                if embedder is not None:
                    et, ep, eo = embedder.embed_batch(
                        [_clap_load(Path(src)), _clap_load(pw), _clap_load(ow)], CLAP_SR)
                    dp["clap"], do["clap"] = _cos_dist(ep, et), _cos_dist(eo, et)
                if cdpam_scorer is not None:
                    dp["cdpam"] = cdpam_scorer.distance(rp, tgt)
                    do["cdpam"] = cdpam_scorer.distance(ro, tgt)
            except Exception as e:
                print(f"  skip {picked}: {e}"); continue
            pairs.append((Path(f).name, dp, do)); n_dec += 1
        if n_dec:
            used.append((Path(f).name, n_dec))

    print(f"\npooled {len(pairs)} decisive pairs from {len(used)} A/Bs")
    if not pairs:
        return
    keys = list(pairs[0][1].keys())
    means = {k: np.mean([v for _n, dp, do in pairs for v in (dp[k], do[k])]) for k in keys}
    stds = {k: (np.std([v for _n, dp, do in pairs for v in (dp[k], do[k])]) or 1.0) for k in keys}

    _learned = ("clap", "cdpam")  # keep composites model-free unless explicitly combining
    scorers = {k: (lambda dd, k=k: dd[k]) for k in keys}
    scorers["composite(spectral z)"] = lambda dd: sum(
        (dd[k] - means[k]) / stds[k] for k in keys if k not in _learned)
    if "f0" in keys:  # cheap timbre+pitch on complementary axes (mss is chance → dilutes; mfcc isn't)
        scorers["mss+f0(z)"] = lambda dd: (
            (dd["mss_l1"] - means["mss_l1"]) / stds["mss_l1"]
            + (dd["f0"] - means["f0"]) / stds["f0"])
        scorers["mfcc+f0(z)"] = lambda dd: (
            (dd["mfcc"] - means["mfcc"]) / stds["mfcc"]
            + (dd["f0"] - means["f0"]) / stds["f0"])
    if "clap" in keys:
        scorers["mfcc+clap(z)"] = lambda dd: sum((dd[k] - means[k]) / stds[k] for k in ("mfcc", "clap"))

    print(f"\n{'metric':24s} {'agree':>8s} {'rate':>6s} {'p(>50%)':>9s}")
    for name, sc in scorers.items():
        w, n = _rate(pairs, sc)
        print(f"{name:24s} {str(w) + '/' + str(n):>8s} {w/n:>5.0%} {binomtest(w, n, 0.5, alternative='greater').pvalue:>9.3f}")

    # Per-A/B breakdown — includes the pitch-sensitive scorers so we can see if mss+f0 recovers
    # the pitch A/B (where only CLAP is above chance today).
    show = [s for s in ("mss_l1", "f0", "mfcc", "mfcc+f0(z)", "clap", "cdpam") if s in scorers]
    print(f"\nper-A/B (decisive n; {'; '.join(show)}):")
    for name, _n in used:
        sub = [p for p in pairs if p[0] == name]
        n_sub = _rate(sub, scorers[show[0]])[1]
        cells = " ".join(
            f"{s} {(_rate(sub, scorers[s])[0] / max(1, _rate(sub, scorers[s])[1])):>4.0%}" for s in show)
        print(f"    {name:30s} n={n_sub:>2d}  {cells}")


if __name__ == "__main__":
    main()
