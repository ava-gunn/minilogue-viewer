"""Pull Gemini re-synthesis contributions (audio + predicted program) from the deployed app
into the local contributions split, then clear them from Vercel Blob.

Submissions are PSEUDO-LABELS: the audio was not rendered by the XD with these params — Gemini
guessed them and a user approved them — so they're flagged source="gemini" and live in their own
split (training/data/contrib), kept apart from the Sobol-sweep ground truth the proxy/encoder
train on.

    CONTRIB_API_URL=https://your-app.vercel.app \\
    CONTRIB_ADMIN_TOKEN=... \\
    python -m training.data.pull_contributions

Materializes (exactly what embed.py / sweep_dataset.py read):
    <out>/audio/NNNNNN.wav   (mono, SR, 1s — the model input length)
    <out>/samples.jsonl      ({id, continuous, discrete, boolean, pitch, rms, source, ...})
    <out>/meta.json
    <out>/.pulled            (ledger of ingested contribution ids; re-runs only add new ones)

Once the split is written and the ledger saved, the pulled ids are deleted from Blob via
DELETE /api/contributions (pass --no-clear to keep them). Cleanup is idempotent and self-healing:
any already-ledgered id the server still returns is re-deleted, so a failed delete retries on the
next run instead of leaking blobs forever.

Needs the `eval` extra (librosa). Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path

import numpy as np

from training import schema, xd_params

_REPO = Path(__file__).resolve().parents[2]
SR = schema.AUDIO["sample_rate"]

_PARAM_IDS = [p["id"] for p in schema.PARAMS]
# SSRF guard: only fetch contribution audio from the Vercel Blob host (override for a custom blob
# domain). Keeps a tampered record from pointing the fetch at file:// or an internal address.
_BLOB_HOST_SUFFIX = os.environ.get("CONTRIB_BLOB_HOST_SUFFIX", ".public.blob.vercel-storage.com")


def _blob_url_ok(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme == "https" and (parsed.hostname or "").endswith(_BLOB_HOST_SUFFIX)


class _BlobRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect hop, so a Blob URL can't 30x-redirect the fetch to an internal
    host (the initial-URL check alone wouldn't catch that)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _blob_url_ok(newurl):
            raise urllib.error.HTTPError(newurl, code, "redirect to non-Blob host blocked", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_blob_opener = urllib.request.build_opener(_BlobRedirectHandler)


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

    if not _blob_url_ok(url):
        raise ValueError(f"refusing non-Blob audio url: {url!r}")
    data = _blob_opener.open(url, timeout=30).read()  # noqa: S310 (validated Blob URL + each hop)
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


def _delete_records(base_url: str, admin_token: str, ids: list[str]) -> int:
    """DELETE <base>/api/contributions { ids } — drop the pulled clips from Blob. Returns the
    count the server reports deleted. Best-effort: callers treat failure as non-fatal since the
    local split is already saved and the ledger makes a re-run retry the delete."""
    url = base_url.rstrip("/") + "/api/contributions"
    body = json.dumps({"ids": ids}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="DELETE",
        headers={"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (configured admin endpoint)
        return int(json.loads(resp.read()).get("deleted", 0))


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
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, default=_REPO / "training" / "data" / "contrib")
    ap.add_argument("--base-url", default=os.environ.get("CONTRIB_API_URL"))
    ap.add_argument("--admin-token", default=os.environ.get("CONTRIB_ADMIN_TOKEN"))
    ap.add_argument(
        "--no-clear",
        action="store_true",
        help="keep contributions in Blob after pulling (default: delete the pulled ones)",
    )
    args = ap.parse_args()

    if not args.base_url or not args.admin_token:
        ap.error("set --base-url/--admin-token or CONTRIB_API_URL/CONTRIB_ADMIN_TOKEN")

    out: Path = args.out
    if out.name == "verified":  # never write unverified pseudo-labels into a trusted split
        ap.error(f"refusing to pull into {out} — that's a verified split; use a quarantine dir")
    (out / "audio").mkdir(parents=True, exist_ok=True)

    ledger = _load_ledger(out)
    samples_path = out / "samples.jsonl"
    next_id = sum(1 for _ in samples_path.open()) if samples_path.exists() else 0

    records = _fetch_records(args.base_url, args.admin_token)
    new_samples: list[dict] = []
    to_delete: list[str] = []
    skipped = 0

    for rec in records:
        cid = rec.get("id")
        if not cid:
            continue
        if cid in ledger:
            # Ingested on an earlier run but still in Blob -> a prior delete didn't land. Re-clear.
            to_delete.append(cid)
            continue
        try:
            raw_by_id = {k: int(v) for k, v in rec["rawById"].items()}
        except (KeyError, TypeError, ValueError, AttributeError):
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

        new_samples.append(
            {
                "id": sid,
                **xd_params._targets(raw_by_id),
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
        ledger.add(cid)
        to_delete.append(cid)

    # Durably persist the split and ledger BEFORE clearing anything from Blob — a crash here
    # leaves the clips intact to re-pull, never a deleted-but-unsaved sample.
    if new_samples:
        with samples_path.open("a") as f:
            for s in new_samples:
                f.write(json.dumps(s) + "\n")
        # New audio invalidates the derived caches; embed.py / sweep_dataset.py rebuild them.
        (out / "mels.npy").unlink(missing_ok=True)
        (out / "embeddings.npy").unlink(missing_ok=True)
    _write_meta(out)
    _save_ledger(out, ledger)

    deleted = 0
    if to_delete and not args.no_clear:
        try:
            deleted = _delete_records(args.base_url, args.admin_token, sorted(to_delete))
        except (urllib.error.URLError, OSError, ValueError) as e:
            print(f"warning: pulled OK but Blob cleanup failed ({e}); retries next run", flush=True)

    clear_msg = (
        f"left {len(to_delete)} in Blob (--no-clear)" if args.no_clear else f"cleared {deleted} from Blob"
    )
    print(
        f"pulled {len(new_samples)} new contribution(s) "
        f"(skipped {skipped} invalid, {len(ledger)} total in ledger) -> {out}\n"
        f"  {clear_msg}"
    )


if __name__ == "__main__":
    main()
