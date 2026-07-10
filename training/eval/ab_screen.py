"""Predict a blind A/B's outcome from its renders alone, via CLAP-cosine — a cheap screen so
model comparisons need less listening. For each source's two variant renders, embeds both + the
target and predicts the winner (the CLAP-closer render), then tallies by variant tag.

Validated at ~71% pair-agreement with human 2AFC (`metric_correlation.py`), so treat it as a
SCREEN, not a verdict — confirm decisive calls by ear. Point it at any refine/ab_* renders dir
that has a targets.tsv (rows: src_path <TAB> pitch <TAB> card, two cards per src).

    python -m training.eval.ab_screen --renders /Volumes/Samples/training/refine/ab_drift
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

from training.eval import infer
from training.eval.clap_metric import ClapScorer


def variant_tag(card: str) -> str:
    return card.rsplit("__", 1)[-1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--renders", type=Path, required=True, help="A/B renders dir (has targets.tsv + <card>/audio/000000.wav)")
    ap.add_argument("--tsv", type=Path, default=None, help="targets.tsv (default: <renders>/targets.tsv)")
    args = ap.parse_args()

    tsv = args.tsv or (args.renders / "targets.tsv")
    by_src: dict[str, list[tuple[str, str]]] = defaultdict(list)  # src -> [(card, tag)]
    for line in tsv.read_text().splitlines():
        if line.strip():
            src, _pitch, card = line.split("\t")
            by_src[src].append((card, variant_tag(card)))

    scorer = ClapScorer()
    tally, rows = Counter(), []
    for src, variants in by_src.items():
        if len(variants) != 2:
            continue
        (cardA, tagA), (cardB, tagB) = variants
        target = infer.load_audio(Path(src))
        rA = infer.load_audio(args.renders / cardA / "audio" / "000000.wav")
        rB = infer.load_audio(args.renders / cardB / "audio" / "000000.wav")
        dA, dB = scorer.distances([rA, rB], target)
        win = tagA if dA < dB else tagB
        tally[win] += 1
        rows.append((Path(src).stem, tagA, float(dA), tagB, float(dB), win))

    print(f"{'source':28s} {'A':>10s} {'distA':>7s} {'B':>10s} {'distB':>7s}  -> predicted")
    for stem, tA, dA, tB, dB, win in rows:
        print(f"{stem:28s} {tA:>10s} {dA:>7.4f} {tB:>10s} {dB:>7.4f}  -> {win}")
    print(f"\npredicted tally ({len(rows)} pairs): {dict(tally)}")


if __name__ == "__main__":
    main()
