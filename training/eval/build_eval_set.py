"""Assemble a single-note eval set as a manifest. Each entry is one pitch-labeled note;
run_eval plays the XD at that note's pitch and scores it against the clip. There is NO
same-instrument-across-octaves requirement — any single notes work.

By default we keep the pitches the model trained on (schema AUDIO["pitches"], or "C4"),
so clips are in-distribution; --pitches any keeps every pitch and --pitches C2,C4 a subset.
NSynth is the easy core (pitch-labeled, wide range, electronic/synthetic = in-domain for a
subtractive synth; acoustic = a stress cohort). You can also add your own clips.

    # download a split from magenta.tensorflow.org/datasets/nsynth, then:
    python -m training.eval.build_eval_set --out eval/set --nsynth ~/data/nsynth-test --limit 80
    python -m training.eval.build_eval_set --out eval/set --dir ~/clips --cohort analog --note C4

Appends to <out>/manifest.jsonl (rm it to rebuild); source files are referenced by path.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from training.eval.infer import TRAIN_PITCH_MIDIS, note_to_midi

SYNTH_SOURCES = {"electronic", "synthetic"}  # in-domain for a subtractive synth


def _pitch_filter(arg: str | None) -> set[int] | None:
    if arg is None:
        return set(TRAIN_PITCH_MIDIS)
    if arg.strip().lower() == "any":
        return None
    return {note_to_midi(p) for p in arg.split(",")}


def from_nsynth(nsynth: Path, pitches: set[int] | None, limit: int | None) -> list[dict]:
    examples = json.loads((nsynth / "examples.json").read_text())
    audio = nsynth / "audio"
    counts: dict[str, int] = defaultdict(int)
    rows: list[dict] = []
    for key, meta in sorted(examples.items()):
        midi = meta.get("pitch")
        if pitches is not None and midi not in pitches:
            continue
        wav = audio / f"{key}.wav"
        if not wav.exists():
            continue
        source = meta.get("instrument_source_str", "")
        cohort = "synth" if source in SYNTH_SOURCES else "acoustic"
        if limit and counts[cohort] >= limit:
            continue
        counts[cohort] += 1
        rows.append(
            {
                "id": key,
                "source_path": str(wav.resolve()),
                "cohort": cohort,
                "family": meta.get("instrument_family_str"),
                "source": source,
                "pitch_midi": midi,
                "velocity": meta.get("velocity"),
            }
        )
    return rows


def from_dir(directory: Path, cohort: str, midi: int, limit: int | None) -> list[dict]:
    wavs = sorted(directory.glob("*.wav"))
    if limit:
        wavs = wavs[:limit]
    return [
        {
            "id": f"{cohort}_{p.stem}",
            "source_path": str(p.resolve()),
            "cohort": cohort,
            "family": None,
            "source": cohort,
            "pitch_midi": midi,
            "velocity": None,
        }
        for p in wavs
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--nsynth", type=Path, help="unpacked NSynth split (examples.json + audio/)")
    ap.add_argument(
        "--pitches", help="pitch names 'C2,C4,C6' | 'any' | default = schema training pitches"
    )
    ap.add_argument("--dir", type=Path, help="a directory of single-note .wav clips")
    ap.add_argument("--cohort", default="custom", help="cohort name for --dir")
    ap.add_argument("--note", default="C4", help="pitch (name) of the --dir clips")
    ap.add_argument("--limit", type=int, help="max clips per cohort")
    args = ap.parse_args()

    rows: list[dict] = []
    if args.nsynth:
        rows += from_nsynth(args.nsynth, _pitch_filter(args.pitches), args.limit)
    if args.dir:
        rows += from_dir(args.dir, args.cohort, note_to_midi(args.note), args.limit)
    if not rows:
        ap.error("nothing selected — pass --nsynth and/or --dir")

    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / "manifest.jsonl").open("a") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")

    counts: dict[tuple, int] = defaultdict(int)
    for row in rows:
        counts[(row["cohort"], row["pitch_midi"])] += 1
    print(f"wrote {len(rows)} entries to {args.out / 'manifest.jsonl'}: {dict(counts)}")


if __name__ == "__main__":
    main()
