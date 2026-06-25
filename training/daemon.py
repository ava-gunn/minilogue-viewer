"""Local verify-and-tune daemon. The localhost web app POSTs a thumbs-up'd contribution
(source audio + the engine's params); the daemon loads it on the connected XD, records,
scores the resynthesis, and — if it matches better than chance — promotes it to the verified
split (weighted by closeness). After N new verified samples it retrains the built-in model in
a background thread and re-exports web/public/models/model.onnx (the browser picks it up on
reload).

It also (optionally) polls the deployed app's /api/contributions for thumbs-up submissions
made by remote users — the ones stored in Vercel (Blob audio + KV metadata) — and runs each
new one through the same hardware verify+promote path. Dedup is by contribution id in a
ledger (<verified>/.remote_pulled), so restarts and re-polls never re-verify the same one.
Enable by setting CONTRIB_API_URL + CONTRIB_ADMIN_TOKEN (or --contrib-url/--contrib-token).

    python -m training.daemon              # connect to the XD, serve on :8753
    # or: scripts/daemon.sh start

POST /verify  {audio: <base64>, ext: "wav", rawById: {id:int,...}, pitch: 60, engine: "builtin"|"gemini"}
GET  /status  -> { verified_total, new_since_tune, tuning, tune_after, remote, remote_verified, remote_seen }

Run from the repo root. Needs the eval + record + train extras and a connected XD/Volt.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.data.pull_contributions import (
    _PARAM_IDS,
    _decode_audio as _download_audio,  # (url, ext) -> model-input signal
    _fetch_records,  # GET <base>/api/contributions (Bearer admin token)
)
from training.eval import infer, metrics
from training.runtime import keep_awake
from training.xd_interface import XdInterface

_REPO = Path(__file__).resolve().parent.parent
FLOOR, REJECT, RMS_FLOOR = 0.65, 4.0, 1e-3


class State:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.lock = threading.Lock()  # serializes hardware + verified-split writes
        self.template = korg.extract_prog_bins(args.template)[0]
        self.xd = XdInterface(
            midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio,
            sample_rate=schema.AUDIO["sample_rate"],
        )
        try:  # if any setup below fails, don't leak the just-opened MIDI/audio ports
            self.verified = args.verified
            (self.verified / "audio").mkdir(parents=True, exist_ok=True)
            if not (self.verified / "meta.json").exists():
                _write_meta(self.verified)
            self.total = _count(self.verified)
            self.new_since_tune = 0
            self.tuning = False
            self.stop = threading.Event()  # set on shutdown -> poll loop exits
            self.remote_verified = 0
            self.ledger_path = self.verified / ".remote_pulled"
            self.remote_ledger: set[str] = (
                set(json.loads(self.ledger_path.read_text())) if self.ledger_path.exists() else set()
            )
            self._wake = keep_awake()
            self._wake.__enter__()
        except BaseException:
            self.xd.close()
            raise

    def save_ledger(self) -> None:
        self.ledger_path.write_text(json.dumps(sorted(self.remote_ledger)))

    def calibrate(self) -> float:
        self.xd.send_patch(self.template, settle_s=self.args.settle)
        cal = self.xd.record(note=60, gate_s=self.args.gate, duration_s=schema.AUDIO["duration_s"])
        return float(np.sqrt(np.mean(cal**2)))

    def close(self) -> None:
        with self.lock:  # wait out any in-flight verify (local or remote) before resetting
            try:
                self.xd.send_patch(self.template, settle_s=0.05)
                self.xd.close()
            finally:
                self._wake.__exit__(None, None, None)


def _write_meta(out: Path) -> None:
    out.joinpath("meta.json").write_text(
        json.dumps(
            {
                "continuous": [p["id"] for p in schema.CONTINUOUS],
                "discrete": [{"id": p["id"], "cardinality": p["cardinality"]} for p in schema.DISCRETE],
                "boolean": [p["id"] for p in schema.BOOLEAN],
                "sample_rate": schema.AUDIO["sample_rate"],
                "duration_s": schema.AUDIO["duration_s"],
                "source": "daemon-verified",
            }
        )
    )


def _count(split: Path) -> int:
    f = split / "samples.jsonl"
    return sum(1 for _ in f.open()) if f.exists() else 0


def _write_wav(path: Path, audio: np.ndarray) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(schema.AUDIO["sample_rate"])
        w.writeframes(pcm.tobytes())


def _decode_audio(audio_b64: str, ext: str) -> np.ndarray:
    import librosa

    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=True) as tmp:
        tmp.write(base64.b64decode(audio_b64))
        tmp.flush()
        y, _ = librosa.load(tmp.name, sr=schema.AUDIO["sample_rate"], mono=True)
    return infer.fit(y)


def _verify_signal(
    state: State, source: np.ndarray, raw_by_id: dict, pitch: int, engine: str, origin: str
) -> dict:
    """Render raw_by_id on the XD, score against source, and promote if it matches better
    than chance. Shared by the local POST handler (origin 'daemon-verified') and the remote
    Vercel poller (origin 'remote-verified'). Serialized on state.lock (one hardware op)."""
    prog_bin = xd_params.write_params(state.template, raw_by_id)
    with state.lock:
        state.xd.send_patch(prog_bin, settle_s=state.args.settle)
        render = state.xd.record(note=pitch, gate_s=state.args.gate, duration_s=schema.AUDIO["duration_s"])
        mel_l1 = float(metrics.compare(source, render)["mel_l1"])
        weight = max(0.0, min(1.0, (REJECT - mel_l1) / (REJECT - FLOOR)))
        status = "verified" if mel_l1 <= FLOOR * 2 else ("rejected" if mel_l1 >= REJECT else "review")

        promoted = status != "rejected"
        should_tune = False
        if promoted:
            sid = state.total
            _write_wav(state.verified / "audio" / f"{sid:06d}.wav", source)
            sample = {
                "id": sid,
                **xd_params._targets(raw_by_id),
                "pitch": pitch,
                "weight": round(weight, 3),
                "mel_l1": round(mel_l1, 3),
                "source": f"{origin}:{engine}",
            }
            with (state.verified / "samples.jsonl").open("a") as f:
                f.write(json.dumps(sample) + "\n")
            (state.verified / "mels.npy").unlink(missing_ok=True)
            state.total += 1
            state.new_since_tune += 1
            # Decide-and-claim the tune atomically under the same lock, so two promoters
            # (the HTTP handler + the remote poll thread) can't both launch a retrain or
            # lose a count between the check and the reset.
            if not state.tuning and state.new_since_tune >= state.args.tune_after:
                state.tuning = True
                state.new_since_tune = 0
                should_tune = True

    if should_tune:
        threading.Thread(target=_tune, args=(state,), daemon=True).start()
    return {
        "status": status,
        "mel_l1": round(mel_l1, 3),
        "weight": round(weight, 3),
        "promoted": promoted,
        "verified_total": state.total,
    }


def verify(state: State, payload: dict) -> dict:
    """Local POST /verify: a thumbs-up'd patch from the localhost web app."""
    raw_by_id = {k: int(v) for k, v in payload["rawById"].items()}
    pitch = int(payload.get("pitch", 60))
    engine = str(payload.get("engine", "unknown"))  # builtin | gemini
    source = _decode_audio(payload["audio"], payload.get("ext", "wav"))
    return _verify_signal(state, source, raw_by_id, pitch, engine, "daemon-verified")


def _pull_remote(state: State) -> None:
    """Poll the deployed app for thumbs-up submissions stored in Vercel (Blob audio + KV
    metadata) and run each new one through the same hardware verify+promote path. Dedup is by
    contribution id in state.remote_ledger: liked patches are verified, everything else (down/
    unrated, malformed) is marked handled so it's never reconsidered; only transient fetch/
    download failures are left unmarked to retry next poll."""
    try:
        records = _fetch_records(state.args.contrib_url, state.args.contrib_token)
    except Exception as e:  # network/auth — try again next interval
        print(f"[remote] fetch failed: {e}", flush=True)
        return

    before = len(state.remote_ledger)
    verified = 0
    for rec in records:
        if state.stop.is_set():
            break
        cid = rec.get("id")
        if not cid or cid in state.remote_ledger:
            continue
        if rec.get("rating") != "up":  # only verify liked patches
            state.remote_ledger.add(cid)
            continue
        try:
            raw_by_id = {k: int(v) for k, v in rec["rawById"].items()}
            if any(pid not in raw_by_id for pid in _PARAM_IDS):
                raise ValueError("incomplete params")
        except (KeyError, TypeError, ValueError) as e:
            print(f"[remote] {cid[:8]} invalid ({e}) — skipping", flush=True)
            state.remote_ledger.add(cid)
            continue
        try:
            source = _download_audio(rec["audioUrl"], rec.get("audioExt", "wav"))
        except ValueError as e:  # bad/non-Blob url -> permanent, mark handled
            print(f"[remote] {cid[:8]} bad audio url ({e}) — skipping", flush=True)
            state.remote_ledger.add(cid)
            continue
        except Exception as e:  # transient (network/timeout) -> leave unmarked, retry next poll
            print(f"[remote] {cid[:8]} download failed: {e} — will retry", flush=True)
            continue
        engine = rec.get("engine") or "unknown"
        res = _verify_signal(
            state, source, raw_by_id, int(rec.get("pitchMidi", 60)), engine, "remote-verified"
        )
        state.remote_ledger.add(cid)
        state.remote_verified += res["promoted"]
        verified += 1
        print(
            f"[remote] {cid[:8]} {engine} -> {res['status']} "
            f"mel_l1={res['mel_l1']} promoted={res['promoted']}",
            flush=True,
        )

    if len(state.remote_ledger) != before:
        state.save_ledger()
        print(f"[remote] +{len(state.remote_ledger) - before} handled ({verified} verified)", flush=True)


def _poll_loop(state: State) -> None:
    print(
        f"[remote] polling {state.args.contrib_url} every {state.args.poll_interval}s "
        f"({len(state.remote_ledger)} already in ledger)",
        flush=True,
    )
    while not state.stop.is_set():
        _pull_remote(state)
        if state.stop.wait(state.args.poll_interval):
            break


def _tune(state: State) -> None:
    env = {**os.environ, "PYTHONPATH": str(_REPO)}
    snap = None
    try:
        # Snapshot the verified split under the lock so the subprocess trains on a consistent
        # set while the daemon keeps appending live verifies — otherwise the tuner can read a
        # torn jsonl line or build a mels.npy that's shorter than samples.jsonl (silent mismatch).
        with state.lock:
            snap = state.verified / ".snapshots" / f"{state.total:06d}"
            shutil.rmtree(snap, ignore_errors=True)
            shutil.copytree(
                state.verified, snap, ignore=shutil.ignore_patterns(".snapshots", "mels.npy")
            )
        print(f"[tune] retraining on {_count(snap)} verified samples ({snap.name})…", flush=True)
        subprocess.run(
            [sys.executable, "-m", "training.finetune", "--data", str(state.args.data),
             "--contrib", str(snap), "--init", "transfer",
             "--epochs", str(state.args.tune_epochs)],
            cwd=_REPO, env=env, check=True,
        )
        subprocess.run(
            [sys.executable, "-m", "training.export", "--checkpoint",
             str(_REPO / "training" / "checkpoints" / "xd_model.pt")],
            cwd=_REPO, env=env, check=True,
        )
        print("[tune] done — model.onnx updated (reload the app to pick it up)", flush=True)
    except subprocess.CalledProcessError as e:
        print(f"[tune] failed: {e}", flush=True)
    finally:
        if snap is not None:
            shutil.rmtree(snap, ignore_errors=True)
        state.tuning = False


def _handler(state: State) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _cors(self) -> None:
            # Echo the allow-origin only for an allowlisted origin (never "*"), so a random
            # site the user visits can't preflight a cross-origin POST to the local hardware.
            origin = self.headers.get("Origin")
            if origin and origin in state.args.allow_origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Daemon-Token")

        def _authorized(self) -> bool:
            """Gate side-effecting requests: reject browser requests from a foreign origin,
            and (if a token is configured) require it. Requests with no Origin (curl, the
            local test client) are allowed — the daemon binds to 127.0.0.1 only."""
            origin = self.headers.get("Origin")
            if origin is not None and origin not in state.args.allow_origin:
                return False
            if state.args.token and self.headers.get("X-Daemon-Token") != state.args.token:
                return False
            return True

        def _json(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):  # quieter
            pass

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:
            if self.path.rstrip("/") == "/status":
                self._json(200, {
                    "verified_total": state.total, "new_since_tune": state.new_since_tune,
                    "tuning": state.tuning, "tune_after": state.args.tune_after,
                    "remote": bool(state.args.contrib_url and state.args.contrib_token),
                    "remote_verified": state.remote_verified,
                    "remote_seen": len(state.remote_ledger),
                })
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path.rstrip("/") != "/verify":
                self._json(404, {"error": "not found"})
                return
            if not self._authorized():
                self._json(403, {"error": "forbidden"})
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length))
                self._json(200, verify(state, payload))
            except Exception:  # log detail server-side; don't leak internals to the caller
                traceback.print_exc()
                self._json(500, {"error": "verify failed"})

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8753)
    ap.add_argument("--data", type=Path, default=Path("/Volumes/Samples/training/xd"))
    ap.add_argument("--verified", type=Path, default=_REPO / "training" / "data" / "contrib" / "verified")
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    ap.add_argument("--tune-after", type=int, default=10, help="retrain after N new verified")
    ap.add_argument("--tune-epochs", type=int, default=40)
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--gate", type=float, default=0.6)
    ap.add_argument("--settle", type=float, default=0.1)
    # Remote pull: poll the deployed app's /api/contributions for thumbs-up submissions.
    ap.add_argument("--contrib-url", default=os.environ.get("CONTRIB_API_URL"),
                    help="deployed app base URL (or CONTRIB_API_URL); enables remote polling")
    ap.add_argument("--contrib-token", default=os.environ.get("CONTRIB_ADMIN_TOKEN"),
                    help="admin token for /api/contributions (or CONTRIB_ADMIN_TOKEN)")
    ap.add_argument("--poll-interval", type=int, default=300, help="seconds between remote pulls")
    ap.add_argument("--no-remote", action="store_true", help="disable remote polling")
    ap.add_argument(
        "--allow-origin",
        default="http://localhost:5173,http://127.0.0.1:5173",
        help="comma-separated browser origins allowed to POST /verify",
    )
    ap.add_argument("--token", default=os.environ.get("DAEMON_TOKEN"),
                    help="if set, require it in the X-Daemon-Token header (or DAEMON_TOKEN env)")
    args = ap.parse_args()
    args.allow_origin = {o.strip() for o in args.allow_origin.split(",") if o.strip()}
    if args.no_remote:
        args.contrib_url = args.contrib_token = None

    state = State(args)
    try:
        cal = state.calibrate()
        print(f"calibration rms={cal:.4f}", flush=True)
        if cal < RMS_FLOOR:
            raise SystemExit("calibration silent — check XD power/volume + Volt input gain")
    except BaseException:  # calibration error/abort -> release ports + caffeinate, don't leak
        state.close()
        raise

    server = ThreadingHTTPServer(("127.0.0.1", args.port), _handler(state))

    def shutdown(*_):
        state.stop.set()  # let the poll loop exit promptly
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    if args.contrib_url and args.contrib_token:
        threading.Thread(target=_poll_loop, args=(state,), daemon=True).start()
    else:
        print("remote polling off (set CONTRIB_API_URL + CONTRIB_ADMIN_TOKEN to enable)", flush=True)

    print(f"daemon ready on http://127.0.0.1:{args.port} | verified={state.total} | tune-after={args.tune_after}", flush=True)
    try:
        server.serve_forever()
    finally:
        state.close()
        print("daemon stopped (XD reset + closed)", flush=True)


if __name__ == "__main__":
    main()
