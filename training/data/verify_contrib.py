"""Verify-and-promote Gemini contributions. Each pull_contributions sample is a pseudo-label
(Gemini guessed the params for some audio). We don't trust it blindly: render the program on
the XD, score the render against the contributed source audio, and keep only what matches —
so the model trains on hardware-verified pairs, not Gemini's opinion.

    # render each contribution on the XD, score, build the review UI (XD connected):
    python -m training.data.verify_contrib --contrib training/data/contrib --render

    # open training/data/contrib/review/review.html, A/B each pair, "Download decisions.json"

    # materialize the verified split for finetune --contrib (auto-verified ∪ human approvals):
    python -m training.data.verify_contrib --contrib training/data/contrib --promote \\
        --decisions ~/Downloads/decisions.json

Score is anchored to the resynthesis eval's bounds: weight = (reject - mel_l1)/(reject - floor),
clamped to [0,1]; a near-floor match is trusted ~like hardware ground truth. Run from repo root.
"""

from __future__ import annotations

import argparse
import json
import shutil
import wave
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.eval import infer, metrics

# Defaults from the factory resynthesis eval: analog noise floor and the no-skill distance.
FLOOR = 0.65
REJECT = 4.0
RMS_FLOOR = 1e-3


def _write_wav(path: Path, audio: np.ndarray, sr: int = schema.AUDIO["sample_rate"]) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _raw_from_sample(sample: dict) -> dict[str, int]:
    """Reconstruct raw param values (by id) from a contrib sample's normalized targets."""
    raw: dict[str, int] = {}
    for i, p in enumerate(schema.CONTINUOUS):
        raw[p["id"]] = int(round(sample["continuous"][i] * p["raw_max"]))
    for i, p in enumerate(schema.DISCRETE):
        raw[p["id"]] = int(sample["discrete"][i])
    for i, p in enumerate(schema.BOOLEAN):
        raw[p["id"]] = int(sample["boolean"][i])
    return raw


def _weight(mel_l1: float, floor: float, reject: float) -> float:
    return float(max(0.0, min(1.0, (reject - mel_l1) / (reject - floor))))


def _status(mel_l1: float, verify_below: float, reject: float) -> str:
    if mel_l1 <= verify_below:
        return "verified"
    if mel_l1 >= reject:
        return "rejected"
    return "review"


def render(args: argparse.Namespace) -> None:
    from training.runtime import keep_awake
    from training.xd_interface import XdInterface

    contrib: Path = args.contrib
    samples = [json.loads(line) for line in (contrib / "samples.jsonl").open()]
    if args.limit:
        samples = samples[: args.limit]
    review_dir = contrib / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    template = korg.extract_prog_bins(args.template)[0]
    verify_below = args.verify_below if args.verify_below is not None else args.floor * 2.0

    xd = XdInterface(
        midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio,
        sample_rate=schema.AUDIO["sample_rate"],
    )
    rows: list[dict] = []
    try:
        xd.send_patch(template, settle_s=args.settle)
        cal = xd.record(note=60, gate_s=args.gate, duration_s=schema.AUDIO["duration_s"])
        if float(np.sqrt(np.mean(cal**2))) < RMS_FLOOR:
            xd.close()
            raise RuntimeError("calibration silent — check XD power/volume + audio input gain")
        with keep_awake():
            for s in samples:
                sid = s["id"]
                source = infer.load_audio(contrib / "audio" / f"{sid:06d}.wav")
                prog_bin = xd_params.write_params(template, _raw_from_sample(s))
                xd.send_patch(prog_bin, settle_s=args.settle)
                rendered = xd.record(
                    note=int(s.get("pitch", 60)), gate_s=args.gate,
                    duration_s=schema.AUDIO["duration_s"],
                )
                _write_wav(review_dir / f"{sid:06d}_render.wav", rendered)
                m = metrics.compare(source, rendered, lowpass_hz=args.lowpass)
                mel_l1 = float(m["mel_l1"])
                rows.append(
                    {
                        "id": sid,
                        "contribution_id": s.get("contribution_id"),
                        "pitch": int(s.get("pitch", 60)),
                        "mel_l1": round(mel_l1, 3),
                        "mss_l1": round(float(m.get("mss_l1", 0.0)), 3),
                        "weight": round(_weight(mel_l1, args.floor, args.reject), 3),
                        "status": _status(mel_l1, verify_below, args.reject),
                    }
                )
                print(f"{sid:06d} mel_l1={mel_l1:.3f} -> {rows[-1]['status']} (w={rows[-1]['weight']})")
    finally:
        xd.send_patch(template, settle_s=0.05)  # leave a benign patch
        xd.close()

    (review_dir / "review.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    _write_review_html(review_dir, rows, args.floor, args.reject)
    counts = {st: sum(r["status"] == st for r in rows) for st in ("verified", "review", "rejected")}
    print(f"\nscored {len(rows)} | {counts} -> open {review_dir / 'review.html'}")


def promote(args: argparse.Namespace) -> None:
    contrib: Path = args.contrib
    rows = [json.loads(line) for line in (contrib / "review" / "review.jsonl").open()]
    by_id = {r["id"]: r for r in rows}
    decisions: dict[str, bool] = {}
    if args.decisions:
        decisions = {int(k): bool(v) for k, v in json.loads(args.decisions.read_text()).items()}

    samples = {s["id"]: s for s in (json.loads(x) for x in (contrib / "samples.jsonl").open())}
    out = args.out or (contrib / "verified")
    (out / "audio").mkdir(parents=True, exist_ok=True)

    kept = []
    for r in rows:
        sid = r["id"]
        approved = decisions.get(sid, r["status"] == "verified")  # default: auto-verified
        if not approved:
            continue
        s = samples[sid]
        new_id = len(kept)
        shutil.copyfile(contrib / "audio" / f"{sid:06d}.wav", out / "audio" / f"{new_id:06d}.wav")
        kept.append(
            {
                "id": new_id,
                "continuous": s["continuous"],
                "discrete": s["discrete"],
                "boolean": s["boolean"],
                "pitch": s.get("pitch", 60),
                "rms": s.get("rms"),
                "weight": r["weight"],  # per-sample confidence for finetune --contrib
                "source": "gemini-verified",
                "mel_l1": r["mel_l1"],
            }
        )

    (out / "samples.jsonl").write_text("".join(json.dumps(s) + "\n" for s in kept))
    shutil.copyfile(contrib / "meta.json", out / "meta.json")
    (out / "mels.npy").unlink(missing_ok=True)
    print(f"promoted {len(kept)}/{len(rows)} to {out} (verified split for finetune --contrib)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--contrib", type=Path, required=True)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--render", action="store_true", help="render+score+build review UI (XD)")
    mode.add_argument("--promote", action="store_true", help="materialize the verified split")
    ap.add_argument("--decisions", type=Path, help="decisions.json from the review UI")
    ap.add_argument("--out", type=Path, help="verified split dir (default <contrib>/verified)")
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    ap.add_argument("--floor", type=float, default=FLOOR)
    ap.add_argument("--reject", type=float, default=REJECT)
    ap.add_argument("--verify-below", type=float, help="mel_l1 cutoff for auto-verified (default floor*2)")
    ap.add_argument("--lowpass", type=float)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--gate", type=float, default=0.6)
    ap.add_argument("--settle", type=float, default=0.1)
    args = ap.parse_args()

    if args.render:
        render(args)
    else:
        promote(args)


def _write_review_html(review_dir: Path, rows: list[dict], floor: float, reject: float) -> None:
    (review_dir / "review.html").write_text(_REVIEW_HTML.replace(
        "__DATA__", json.dumps({"rows": rows, "floor": floor, "reject": reject})
    ))


_REVIEW_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Contribution Review</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f10; --card:#141a1c; --line:#243033;
    --teal:#2dd4bf; --amber:#f0a830; --red:#e0566c; --text:#dce8e6; --dim:#7d8c8a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  header { position:sticky; top:0; background:#0b0f10ee; backdrop-filter:blur(6px);
    border-bottom:1px solid var(--line); padding:1rem 1.5rem; display:flex; gap:1.5rem;
    align-items:center; flex-wrap:wrap; }
  h1 { font-size:1.05rem; margin:0; letter-spacing:.04em; }
  .summary { color:var(--dim); font-variant-numeric:tabular-nums; }
  button { font:inherit; background:var(--teal); color:#04110f; border:0; border-radius:.4rem;
    padding:.45rem .9rem; cursor:pointer; font-weight:600; }
  button.ghost { background:transparent; color:var(--dim); border:1px solid var(--line); }
  main { max-width:920px; margin:0 auto; padding:1.25rem; display:grid; gap:.75rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:.6rem;
    padding:.9rem 1.1rem; display:grid; grid-template-columns:8rem 1fr auto; gap:1rem;
    align-items:center; }
  .card[data-decision="reject"] { opacity:.5; }
  .badge { display:inline-block; padding:.1rem .5rem; border-radius:1rem; font-size:.72rem;
    font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
  .verified { background:#0f3d36; color:var(--teal); }
  .review { background:#3d3110; color:var(--amber); }
  .rejected { background:#3d1620; color:var(--red); }
  .score { color:var(--dim); font-variant-numeric:tabular-nums; font-size:.8rem; margin-top:.3rem; }
  .wbar { height:5px; border-radius:3px; background:var(--line); margin-top:.4rem; overflow:hidden; }
  .wbar > i { display:block; height:100%; background:var(--teal); }
  .players { display:grid; gap:.35rem; }
  .players label { display:grid; grid-template-columns:5rem 1fr; align-items:center; gap:.5rem;
    color:var(--dim); font-size:.8rem; }
  audio { width:100%; height:30px; }
  .decide { display:flex; gap:.35rem; }
  .decide button { background:transparent; border:1px solid var(--line); color:var(--dim);
    padding:.35rem .7rem; }
  .card[data-decision="approve"] .approve { background:var(--teal); color:#04110f; border-color:var(--teal); }
  .card[data-decision="reject"] .reject { background:var(--red); color:#1a0309; border-color:var(--red); }
  .id { color:var(--dim); font-size:.7rem; font-family:ui-monospace,monospace; }
</style></head><body>
<header>
  <h1>Contribution Review</h1>
  <div class="summary" id="summary"></div>
  <div class="summary" id="bounds"></div>
  <button id="export">Download decisions.json</button>
  <button class="ghost" id="onlyReview">Show review-band only</button>
</header>
<main id="list"></main>
<script>
const DATA = __DATA__;
const list = document.getElementById('list');
const decisions = {};
for (const r of DATA.rows) decisions[r.id] = r.status !== 'rejected';

function pad(n){ return String(n).padStart(6,'0'); }
function render(filter){
  list.replaceChildren();
  for (const r of DATA.rows){
    if (filter && r.status !== 'review') continue;
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.decision = decisions[r.id] ? 'approve' : 'reject';
    el.innerHTML = `
      <div>
        <span class="badge ${r.status}">${r.status}</span>
        <div class="score">mel_l1 ${r.mel_l1.toFixed(3)}</div>
        <div class="wbar"><i style="width:${Math.round(r.weight*100)}%"></i></div>
        <div class="id">${(r.contribution_id||'#'+r.id)}</div>
      </div>
      <div class="players">
        <label>target <audio controls preload="none" src="../audio/${pad(r.id)}.wav"></audio></label>
        <label>XD render <audio controls preload="none" src="./${pad(r.id)}_render.wav"></audio></label>
      </div>
      <div class="decide">
        <button class="approve">approve</button>
        <button class="reject">reject</button>
      </div>`;
    el.querySelector('.approve').onclick = () => { decisions[r.id]=true; el.dataset.decision='approve'; summary(); };
    el.querySelector('.reject').onclick = () => { decisions[r.id]=false; el.dataset.decision='reject'; summary(); };
    list.append(el);
  }
}
function summary(){
  const a = Object.values(decisions).filter(Boolean).length;
  const c = {verified:0, review:0, rejected:0};
  for (const r of DATA.rows) c[r.status]++;
  document.getElementById('summary').textContent =
    `${DATA.rows.length} scored · ${c.verified} verified · ${c.review} review · ${c.rejected} rejected · ${a} approved`;
}
document.getElementById('bounds').textContent = `floor ${DATA.floor} · reject ${DATA.reject}`;
document.getElementById('export').onclick = () => {
  const blob = new Blob([JSON.stringify(decisions,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'decisions.json'; a.click();
};
let filtered = false;
document.getElementById('onlyReview').onclick = (e) => { filtered=!filtered; e.target.textContent = filtered?'Show all':'Show review-band only'; render(filtered); };
render(false); summary();
</script></body></html>
"""


if __name__ == "__main__":
    main()
