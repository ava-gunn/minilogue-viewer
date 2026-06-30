"""Blind A/B web app: for each source sound, pick the closer of two resynths.

Each source has TWO candidate renders (e.g. two encoders) — the TSV's two rows
sharing a `src`. Per source the tool shows ONE card with the level-matched Source
plus two blind candidates A and B (slot order randomized server-side, identities
hidden); you pick "A closer" / "tie" / "B closer". Forced per-sound 2AFC removes
the cross-sound ranking noise + labeling bias of the old drag-rank. Submissions
append to results/results.jsonl and dump per-run to results/abtest_<ts>.json,
with the blind slots decoded back to variant tags + a win tally.

    training/.venv/bin/python tools/abtest/serve.py [--open]

Options:
    --tsv PATH     targets TSV (src\\tpitch\\tname); two rows per src = the A/B pair
    --renders DIR  render = DIR/<name>/audio/000000.wav
    --port N       [8077]
    --seed N       blind A/B slot assignment (default: random per run)
    --open         open the browser on start
"""
import argparse
import datetime as dt
import io
import json
import random
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from training import audio_distance              # noqa: E402
from training.eval import metrics as M           # noqa: E402

HERE = Path(__file__).resolve().parent
SR = audio_distance.SR


def level_match(path: Path) -> bytes:
    """Load, fit to N_SAMPLES, rms-normalize, peak-guard — return WAV bytes (so loudness
    doesn't bias the A/B; same prep as the Phase-0 metrics)."""
    x = librosa.load(str(path), sr=SR, mono=True)[0]
    x = M.rms_normalize(M.fit(x))
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.95
    buf = io.BytesIO()
    sf.write(buf, x, SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def variant_tag(name: str) -> str:
    """`bass_skull_c1__recon` -> `recon` (the bit after the last `__`)."""
    return name.rsplit("__", 1)[-1] if "__" in name else name


def load_trials(tsv: Path, renders: Path, rng: random.Random):
    """Group TSV rows by `src` into 2-candidate trials; randomize the A/B slot (blind)."""
    groups: "OrderedDict[str, list]" = OrderedDict()
    for line in tsv.read_text().splitlines():
        if not line.strip():
            continue
        src, pitch, name = line.split("\t")
        groups.setdefault(src, []).append((name, int(pitch)))

    trials = []
    for i, (src, members) in enumerate(groups.items()):
        if len(members) != 2:
            print(f"  ! skip {Path(src).stem}: need exactly 2 variants, got {len(members)}")
            continue
        (na, _), (nb, pitch) = members
        if rng.random() < 0.5:           # blind: which candidate lands in slot A
            na, nb = nb, na
        trials.append({"id": i, "src": src, "pitch": pitch, "label": Path(src).stem, "A": na, "B": nb})
    return trials


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind A/B resynth</title>
<style>
  :root {
    --bg:#0d0f14; --card:#181c24; --hi:#1f2530; --line:#2a313d; --ink:#e6e9ef;
    --dim:#8a93a3; --src:#4f8cff; --cand:#b9a3ff; --good:#2ec27e;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding:28px clamp(16px,4vw,48px); }
  header { margin-bottom:18px; }
  h1 { font-size:20px; font-weight:650; margin:0 0 2px; }
  .sub { color:var(--dim); font-size:13px; }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fill, minmax(260px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:16px; display:flex; flex-direction:column; gap:12px; }
  .card.done { border-color:var(--good); }
  .head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  .label { font-weight:600; font-size:14px; word-break:break-word; }
  .meta { color:var(--dim); font-size:12px; font-variant-numeric:tabular-nums; }
  button { font:inherit; cursor:pointer; border-radius:9px; border:1px solid var(--line); }
  .play { background:var(--hi); color:var(--ink); padding:9px 10px; font-size:13px; font-weight:600;
    display:flex; align-items:center; justify-content:center; gap:8px; transition:background .1s,border-color .1s; }
  .play:hover { background:#262d39; }
  .play .dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
  .play.src .dot { background:var(--src); }
  .play.cand .dot { background:var(--cand); }
  .play.playing { border-color:currentColor; }
  .ab { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .choice { display:grid; grid-template-columns:1fr auto 1fr; gap:8px; }
  .pick { background:transparent; color:var(--dim); padding:9px 8px; font-size:13px; font-weight:600; }
  .pick:hover { color:var(--ink); border-color:#3a4250; }
  .pick.sel { background:var(--good); color:#06210f; border-color:var(--good); }
  .pick.tie { font-size:12px; }
  footer { position:sticky; bottom:0; margin-top:20px; padding-top:14px;
    background:linear-gradient(transparent, var(--bg) 30%); display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  button.submit { background:var(--src); color:#fff; border:0; padding:11px 22px; font-weight:650; }
  button.submit:hover { filter:brightness(1.08); }
  .msg { font-size:13px; } .msg.ok { color:var(--good); } .msg.err { color:#e2564d; }
  .count { color:var(--dim); font-size:13px; }
</style>
</head>
<body>
  <header>
    <h1>Blind A/B — pick the closer resynth</h1>
    <span class="sub">play the Target, then A and B (blind), and choose which is the closer match. One pick per sound.</span>
  </header>
  <div class="grid" id="grid"></div>
  <footer>
    <button class="submit" id="submit">Submit</button>
    <span class="count" id="count"></span>
    <span class="msg" id="msg"></span>
  </footer>
<script>
const grid = document.getElementById('grid');
const msg = document.getElementById('msg');
const countEl = document.getElementById('count');
let audio = new Audio(); let playingBtn = null;
const choices = {};  // id -> "A" | "B" | "tie"

function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function play(id, which, btn){
  if (playingBtn === btn){ audio.pause(); stopUI(); return; }
  stopUI();
  audio = new Audio(`/audio/${id}/${which}`);
  audio.onended = stopUI; audio.play();
  playingBtn = btn; btn.classList.add('playing');
}
function stopUI(){ if(playingBtn) playingBtn.classList.remove('playing'); playingBtn = null; }

function updateCount(){
  const n = Object.keys(choices).length, total = grid.children.length;
  countEl.textContent = `${n} / ${total} chosen`;
}

function makeCard(t){
  const el = document.createElement('div');
  el.className = 'card'; el.dataset.id = t.id;
  el.innerHTML = `
    <div class="head"><span class="label">${t.label}</span><span class="meta">midi ${t.pitch}</span></div>
    <button class="play src"><span class="dot"></span>Target</button>
    <div class="ab">
      <button class="play cand" data-w="A"><span class="dot"></span>A</button>
      <button class="play cand" data-w="B"><span class="dot"></span>B</button>
    </div>
    <div class="choice">
      <button class="pick" data-c="A">A closer</button>
      <button class="pick tie" data-c="tie">tie</button>
      <button class="pick" data-c="B">B closer</button>
    </div>`;
  el.querySelector('.play.src').onclick = e => play(t.id, 'source', e.currentTarget);
  el.querySelectorAll('.play.cand').forEach(b =>
    b.onclick = e => play(t.id, e.currentTarget.dataset.w, e.currentTarget));
  el.querySelectorAll('.pick').forEach(b => b.onclick = () => {
    choices[t.id] = b.dataset.c;
    el.querySelectorAll('.pick').forEach(x => x.classList.toggle('sel', x === b));
    el.classList.add('done');
    updateCount();
  });
  return el;
}

async function init(){
  const trials = shuffle(await (await fetch('/trials')).json());
  trials.forEach(t => grid.appendChild(makeCard(t)));
  updateCount();
}

document.getElementById('submit').onclick = async () => {
  const total = grid.children.length, n = Object.keys(choices).length;
  if (n < total && !confirm(`${total - n} sound(s) unrated — submit anyway?`)) return;
  msg.className = 'msg'; msg.textContent = 'submitting…';
  try {
    const r = await fetch('/submit', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ choices }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    msg.className = 'msg ok'; msg.textContent = `saved → ${j.file}  (${j.summary})`;
  } catch (e) { msg.className = 'msg err'; msg.textContent = 'failed: ' + e.message; }
};
init();
</script>
</body>
</html>"""


def make_handler(trials, wavs, renders, results_dir):
    by_id = {t["id"]: t for t in trials}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, code, body, ctype="application/json"):
            if isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/":
                return self._send(200, PAGE, "text/html; charset=utf-8")
            if path == "/trials":  # blind: NO variant names sent to the client
                return self._send(200, json.dumps(
                    [{"id": t["id"], "label": t["label"], "pitch": t["pitch"]} for t in trials]))
            if path.startswith("/audio/"):
                _, _, tid, which = path.split("/", 3)
                key = (int(tid), which) if tid.isdigit() else None
                if key in wavs:
                    return self._send(200, wavs[key], "audio/wav")
                return self._send(404, json.dumps({"error": "no such clip"}))
            return self._send(404, json.dumps({"error": "not found"}))

        def do_POST(self):
            if self.path != "/submit":
                return self._send(404, json.dumps({"error": "not found"}))
            n = int(self.headers.get("Content-Length", 0))
            try:
                choices = json.loads(self.rfile.read(n) or b"{}").get("choices", {})
            except json.JSONDecodeError:
                return self._send(400, json.dumps({"error": "bad json"}))

            ts = dt.datetime.now()
            out, tally = [], {}
            for t in trials:
                ch = choices.get(str(t["id"]))  # JSON object keys are strings
                a_tag, b_tag = variant_tag(t["A"]), variant_tag(t["B"])
                winner = {"A": a_tag, "B": b_tag}.get(ch, "tie" if ch == "tie" else None)
                if winner is not None:
                    tally[winner] = tally.get(winner, 0) + 1
                out.append({"source": t["label"], "pitch": t["pitch"], "A": t["A"], "B": t["B"],
                            "choice": ch, "winner": winner})
            summary = "  ".join(f"{k}:{v}" for k, v in sorted(tally.items()))
            record = {
                "timestamp": ts.isoformat(timespec="seconds"), "renders_dir": str(renders),
                "n_trials": len(trials), "n_rated": sum(1 for t in out if t["choice"]),
                "tally": tally, "trials": out,
            }
            fname = f"abtest_{ts.strftime('%Y%m%d_%H%M%S')}.json"
            (results_dir / fname).write_text(json.dumps(record, indent=2))
            with (results_dir / "results.jsonl").open("a") as f:
                f.write(json.dumps(record) + "\n")
            print(f"\n  submitted {record['n_rated']}/{len(trials)} blind A/B picks — tally: {summary or '(none)'}")
            for t in out:
                print(f"    {t['source']:22s} {t['choice'] or '-':4s} -> {t['winner'] or '-'}  (A={variant_tag(t['A'])} B={variant_tag(t['B'])})")
            print(f"  saved -> {results_dir / fname}")
            return self._send(200, json.dumps({"ok": True, "file": fname, "summary": summary}))

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tsv", type=Path, default=HERE / "ghost_targets.tsv")
    ap.add_argument("--renders", type=Path, default=Path("/Volumes/Samples/training/refine/inreach_ghost"))
    ap.add_argument("--port", type=int, default=8077)
    ap.add_argument("--seed", type=int, default=None, help="blind A/B slot seed (default: random per run)")
    ap.add_argument("--open", action="store_true")
    args = ap.parse_args()

    results_dir = HERE / "results"
    results_dir.mkdir(exist_ok=True)
    trials = load_trials(args.tsv, args.renders, random.Random(args.seed))
    if not trials:
        sys.exit(f"no 2-variant trials in {args.tsv} (need two rows per src)")

    print(f"level-matching {len(trials)} trials (source + A + B each)…")
    wavs = {}
    for t in trials:
        clips = {"source": Path(t["src"]),
                 "A": args.renders / t["A"] / "audio" / "000000.wav",
                 "B": args.renders / t["B"] / "audio" / "000000.wav"}
        for which, path in clips.items():
            if not path.exists():
                print(f"  ! missing {which} for {t['label']}: {path}")
                continue
            wavs[(t["id"], which)] = level_match(path)

    handler = make_handler(trials, wavs, args.renders, results_dir)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"\nserving {len(trials)} blind A/B trials at {url}")
    print(f"results -> {results_dir}/   (per-run json + results.jsonl)\nctrl-c to stop\n")
    if args.open:
        import webbrowser
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
