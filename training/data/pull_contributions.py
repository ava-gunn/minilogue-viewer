"""Pull Gemini re-synthesis contributions (audio + predicted program) from the deployed
app into a local training/eval split. Submissions are PSEUDO-LABELS: the audio was not
rendered by the XD with these params — Gemini guessed them and a user approved them — so
this split is kept separate from the hardware-recorded ground truth, flagged source="gemini",
and down-weighted by finetune.py (--contrib). The saved .mnlgxdprog programs let you render
each on the XD and score it (eval) to verify before trusting a sample for training.

    CONTRIB_API_URL=https://your-app.vercel.app \\
    CONTRIB_ADMIN_TOKEN=... \\
    python -m training.data.pull_contributions --out training/data/contrib --eval eval/set

Materializes, mirroring the xd_record dataset shape so XdDataset loads it unchanged:
    <out>/audio/NNNNNN.wav      (mono, SR, 1s — fit like the model input)
    <out>/samples.jsonl         ({id, continuous, discrete, boolean, pitch, rms, source, ...})
    <out>/programs/<uuid>.mnlgxdprog
    <out>/meta.json
    <out>/.pulled               (ledger of ingested contribution ids; re-runs only add new)
    <eval>/manifest.jsonl       (+ rows: cohort="contrib", source_path -> the contrib wav)

Needs the `eval` extra (librosa) + a program template. Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params

_REPO = Path(__file__).resolve().parents[2]
DEFAULT_TEMPLATE = _REPO / "web" / "replicant-example.mnlgxdprog"
SR = schema.AUDIO["sample_rate"]

_PARAM_IDS = [p["id"] for p in schema.PARAMS]
# SSRF guard: only fetch contribution audio from the Vercel Blob host (override for a
# custom blob domain). Keeps a tampered record from pointing the fetch at file:// or
# an internal address.
_BLOB_HOST_SUFFIX = os.environ.get("CONTRIB_BLOB_HOST_SUFFIX", ".public.blob.vercel-storage.com")


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _fit(signal: np.ndarray, n: int = schema.N_SAMPLES) -> np.ndarray:
    """Crop/zero-pad to exactly n samples from the onset — the model's fixed input length."""
    signal = np.asarray(signal, dtype=np.float32)
    if len(signal) >= n:
        return signal[:n]
    out = np.zeros(n, dtype=np.float32)
    out[: len(signal)] = signal
    return out


def _decode_audio(url: str, ext: str) -> np.ndarray:
    """Download a contribution clip and load it as the model input (SR, mono, 1s). Refuses
    anything but an https Vercel Blob URL so a tampered record can't redirect the fetch at
    file:// or an internal host (SSRF defense)."""
    import librosa

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not (parsed.hostname or "").endswith(_BLOB_HOST_SUFFIX):
        raise ValueError(f"refusing non-Blob audio url: {url!r}")
    data = urllib.request.urlopen(url, timeout=30).read()  # noqa: S310 (validated Blob URL)
    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        y, _ = librosa.load(tmp.name, sr=SR, mono=True)
    return _fit(y)


def _fetch_records(base_url: str, admin_token: str) -> list[dict]:
    url = base_url.rstrip("/") + "/api/contributions"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {admin_token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (configured admin endpoint)
        payload = json.loads(resp.read())
    return payload.get("contributions", [])


def _load_ledger(out: Path) -> set[str]:
    path = out / ".pulled"
    return set(json.loads(path.read_text())) if path.exists() else set()


def _save_ledger(out: Path, ids: set[str]) -> None:
    (out / ".pulled").write_text(json.dumps(sorted(ids)))


def _write_meta(out: Path) -> None:
    out.joinpath("meta.json").write_text(
        json.dumps(
            {
                "continuous": [p["id"] for p in schema.CONTINUOUS],
                "discrete": [
                    {"id": p["id"], "cardinality": p["cardinality"]} for p in schema.DISCRETE
                ],
                "boolean": [p["id"] for p in schema.BOOLEAN],
                "sample_rate": SR,
                "duration_s": schema.AUDIO["duration_s"],
                "source": "gemini",
                "note": "pseudo-labeled: programs predicted by Gemini, approved by a user",
            }
        )
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=_REPO / "training" / "data" / "contrib")
    ap.add_argument("--eval", type=Path, help="eval set dir to append manifest rows to")
    ap.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    ap.add_argument("--base-url", default=os.environ.get("CONTRIB_API_URL"))
    ap.add_argument("--admin-token", default=os.environ.get("CONTRIB_ADMIN_TOKEN"))
    args = ap.parse_args()

    if not args.base_url or not args.admin_token:
        ap.error("set --base-url/--admin-token or CONTRIB_API_URL/CONTRIB_ADMIN_TOKEN")

    out: Path = args.out
    if out.name == "verified":  # never write unverified pseudo-labels into a trusted split
        ap.error(f"refusing to pull into {out} — that's a verified split; use a quarantine dir")
    (out / "audio").mkdir(parents=True, exist_ok=True)
    (out / "programs").mkdir(parents=True, exist_ok=True)

    template = korg.extract_prog_bins(args.template)[0]
    ledger = _load_ledger(out)
    next_id = sum(1 for _ in (out / "samples.jsonl").open()) if (out / "samples.jsonl").exists() else 0

    records = _fetch_records(args.base_url, args.admin_token)
    new_samples: list[dict] = []
    new_eval_rows: list[dict] = []
    skipped = 0

    for rec in records:
        cid = rec.get("id")
        if not cid or cid in ledger:
            continue
        try:
            raw_by_id = {k: int(v) for k, v in rec["rawById"].items()}
        except (KeyError, TypeError, ValueError):
            skipped += 1
            continue
        if any(pid not in raw_by_id for pid in _PARAM_IDS):
            skipped += 1
            continue

        audio = _decode_audio(rec["audioUrl"], rec.get("audioExt", "wav"))
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0

        sid = next_id
        next_id += 1
        _write_wav(out / "audio" / f"{sid:06d}.wav", audio, SR)

        prog_bin = xd_params.write_params(template, raw_by_id)
        korg.write_mnlgxdprog(args.template, prog_bin, out / "programs" / f"{cid}.mnlgxdprog")

        targets = xd_params._targets(raw_by_id)
        new_samples.append(
            {
                "id": sid,
                **targets,
                "pitch": int(rec.get("pitchMidi", 60)),
                "rms": rms,
                "source": "gemini",
                "engine": rec.get("engine"),
                "rating": rec.get("rating"),
                "model": rec.get("model"),
                "prompt_version": rec.get("promptVersion"),
                "contribution_id": cid,
            }
        )
        if args.eval:
            new_eval_rows.append(
                {
                    "id": f"contrib_{cid}",
                    "source_path": str((out / "audio" / f"{sid:06d}.wav").resolve()),
                    "cohort": "contrib",
                    "family": None,
                    "source": "gemini",
                    "pitch_midi": int(rec.get("pitchMidi", 60)),
                    "velocity": None,
                }
            )
        ledger.add(cid)

    if new_samples:
        with (out / "samples.jsonl").open("a") as f:
            for s in new_samples:
                f.write(json.dumps(s) + "\n")
        # New audio invalidates the precomputed mels; XdDataset rebuilds them on next load.
        (out / "mels.npy").unlink(missing_ok=True)
    _write_meta(out)
    _save_ledger(out, ledger)

    if args.eval and new_eval_rows:
        args.eval.mkdir(parents=True, exist_ok=True)
        with (args.eval / "manifest.jsonl").open("a") as f:
            for row in new_eval_rows:
                f.write(json.dumps(row) + "\n")

    print(
        f"pulled {len(new_samples)} new contribution(s) "
        f"(skipped {skipped} invalid, {len(ledger)} total in ledger) -> {out}\n"
        "  NOTE: UNVERIFIED Gemini pseudo-labels — hardware-verify (training.data.verify_contrib "
        "or the daemon) before trusting them; finetune --contrib mixes them in down-weighted."
    )


if __name__ == "__main__":
    main()
