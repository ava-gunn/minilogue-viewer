"""Stage 4 — hardware refinement (CMA-ES as last-mile corrector). The encoder gives a good
initial patch; CMA-ES then searches a small neighborhood of it *on the real XD* to correct
proxy/encoder error the gradient pipeline couldn't see.

    python -m training.refine --target sound.wav --out match.mnlgxdprog
    python -m training.refine --smoke     # no hardware/cma-on-hardware: prove the CMA-ES loop

1. encoder estimate (web/public/models/model.onnx) -> raw params
2. render on the XD, record, score multi-scale STFT-L1 (RMS-normalized) vs target
3. if that exceeds --threshold, CMA-ES over the *continuous* params only (the smooth ones:
   cutoff, EG times, levels…), holding the discrete heads (waves/filter type) fixed — those
   are categorical and the encoder picks them outright. Each candidate is a hardware render.
4. optionally stash the best (params, audio) into --accumulate for later proxy improvement.

Hardware renders dominate the cost, so the budget is --evals (objective calls). Needs the
`eval` extra (librosa + onnxruntime), the `record` extra (XD I/O), and `refine` (cma).
Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

from training import korg, schema, xd_params
from training.eval import infer, metrics
from training.xd_interface import XdInterface

CONTINUOUS = schema.CONTINUOUS

# Categorical params that set a sound's *character*; the encoder is weak on these (~25% acc)
# and continuous CMA-ES holds them fixed, so they're the obvious thing to search directly on
# the XD. All small cardinality (waves 3, octaves 4, multi_type 3, drive/EG-target 3) — cheap
# to coordinate-search. Excludes voice_mode (forced POLY) and the pitch `octave`.
DEFAULT_DISC_GROUPS = "vco1_wave,vco1_octave,vco2_wave,vco2_octave,multi_type,filter_drive,eg_target"

# VCO octave index that makes a played note sound at its nominal pitch (8' footing).
# Calibrated on the XD: index 0=16'(-1 oct), 1=8'(0), 2=4'(+1 oct). The encoder's octave guess
# is unreliable (it put a bass an octave low); when we render at the target's own pitch the
# correct footing is fixed, so anchor it instead of trusting/searching it. (voice.octave has no
# effect on received MIDI notes, so it's left alone.)
NEUTRAL_VCO_OCTAVE = 1
_OCTAVE_GROUPS = ("vco1_octave", "vco2_octave", "octave")


def to_continuous_unit(raw: dict[str, int]) -> np.ndarray:
    return np.array([raw[p["id"]] / p["raw_max"] for p in CONTINUOUS], dtype=np.float64)


def detect_pitch_midi(audio: np.ndarray, sr: int, *, default: int = 60) -> int:
    """Median voiced f0 of the target -> nearest MIDI note, so we render the candidate at the
    SOURCE's pitch (matching is timbre; pitch is the played note). Fixed-pitch rendering was
    grading off-pitch renders — mel_l1 is nearly pitch-blind, so it never noticed."""
    import librosa

    f, voiced, _ = librosa.pyin(audio, fmin=32.7, fmax=1046.5, sr=sr, frame_length=2048)
    f = f[voiced & ~np.isnan(f)]
    if not len(f):
        return default
    midi = int(round(69 + 12 * np.log2(float(np.median(f)) / 440.0)))
    return max(12, min(108, midi))


def _disc_offsets() -> dict[str, tuple[int, int]]:
    """group id -> (start offset, cardinality) into the flat discrete-logit vector."""
    offs, o = {}, 0
    for p in schema.DISCRETE:
        offs[p["id"]] = (o, p["cardinality"])
        o += p["cardinality"]
    return offs


def discrete_screen(base_raw, disc_logits, render, score, *, groups, topk, passes):
    """Coordinate-descent over categorical (osc/filter/EG) params on the real XD, with the
    continuous params held at the encoder estimate. Each candidate value is one hardware
    render; we only try the encoder's top-k logits per group (a decent prior over which
    waves/types are plausible). One pass = sum of (≤topk) candidates over the groups; stops
    early when a full pass makes no change. Returns (best raw patch, its distance)."""
    offs = _disc_offsets()
    cur = dict(base_raw)
    cur_d = score(render(cur))
    for _ in range(passes):
        changed = False
        for gid in groups:
            if gid not in offs:
                continue
            o, card = offs[gid]
            order = [int(i) for i in np.argsort(disc_logits[o : o + card])[::-1][:topk]]
            before = keep = cur[gid]
            for idx in order:
                if idx == before:
                    continue
                cur[gid] = idx
                d = score(render(cur))
                if d < cur_d:
                    cur_d, keep = d, idx
            cur[gid] = keep
            changed = changed or keep != before
        if not changed:
            break
    return cur, cur_d


def apply_continuous(base_raw: dict[str, int], x) -> dict[str, int]:
    """Overlay a continuous unit-vector onto the fixed (discrete/boolean) base estimate."""
    raw = dict(base_raw)
    for p, xi in zip(CONTINUOUS, x):
        raw[p["id"]] = int(min(p["raw_max"], max(0, round(float(xi) * p["raw_max"]))))
    return raw


def _write_wav(path: Path, audio: np.ndarray, sr: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _accumulate(out: Path, raw: dict[str, int], audio: np.ndarray, sr: int) -> None:
    (out / "audio").mkdir(parents=True, exist_ok=True)
    manifest = out / "samples.jsonl"
    idx = sum(1 for _ in manifest.open()) if manifest.exists() else 0
    _write_wav(out / "audio" / f"{idx:06d}.wav", audio, sr)
    with manifest.open("a") as f:
        f.write(json.dumps({"id": idx, "source": "refine", **xd_params.targets_for(raw)}) + "\n")


def refine(target, session, template, render, *, threshold, evals, sigma, seed,
           search_discrete=False, disc_groups=(), disc_topk=4, disc_passes=2, lowpass=None,
           anchor_octave=True):
    """render(raw) -> recorded audio. Returns (best_raw, best_distance, best_audio)."""
    cont_o, disc_o, boo_o = infer.run_model(session, target)
    base_raw = infer.decode_raw(cont_o, disc_o, boo_o)

    if anchor_octave:  # render at the played note's nominal pitch; don't trust/search the octave
        base_raw["vco1_octave"] = base_raw["vco2_octave"] = NEUTRAL_VCO_OCTAVE
        disc_groups = tuple(g for g in disc_groups if g not in _OCTAVE_GROUPS)

    tgt = metrics.rms_normalize(metrics.fit(target))
    if lowpass:
        tgt = metrics.lowpass(tgt, lowpass)

    def score(audio) -> float:  # multi-scale STFT-L1: best ear agreement in the Phase-0 bake-off
        cand = metrics.rms_normalize(metrics.fit(audio))
        if lowpass:
            cand = metrics.lowpass(cand, lowpass)
        return metrics.multiscale_stft_l1(tgt, cand)

    best_audio = render(base_raw)
    best_d = score(best_audio)
    best_raw = base_raw
    print(f"encoder estimate: dist={best_d:.4f}")

    if search_discrete and disc_groups:
        screened, sd = discrete_screen(
            base_raw, disc_o, render, score,
            groups=disc_groups, topk=disc_topk, passes=disc_passes,
        )
        changes = {g: (base_raw[g], screened[g]) for g in disc_groups if screened.get(g) != base_raw.get(g)}
        print(f"discrete screen: dist {best_d:.4f} -> {sd:.4f}  changed={changes}")
        base_raw = screened  # continuous CMA-ES starts from the better discrete
        if sd < best_d:
            best_d, best_raw, best_audio = sd, screened, render(screened)

    if best_d <= threshold:
        print("within threshold — skipping CMA-ES")
        return best_raw, best_d, best_audio

    import cma  # the `refine` extra

    es = cma.CMAEvolutionStrategy(
        to_continuous_unit(base_raw).tolist(),
        sigma,
        {"bounds": [0.0, 1.0], "maxfevals": evals, "seed": seed, "verbose": -9},
    )
    done = 0
    while not es.stop():
        candidates = es.ask()
        losses = []
        for x in candidates:
            raw = apply_continuous(base_raw, x)
            audio = render(raw)
            d = score(audio)
            losses.append(d)
            done += 1
            if d < best_d:
                best_d, best_raw, best_audio = d, raw, audio
        es.tell(candidates, losses)
        print(f"  evals {done}: best dist={best_d:.4f}")
    print(f"CMA-ES refined dist {score(render(base_raw)):.4f} -> {best_d:.4f}")
    return best_raw, best_d, best_audio


def _smoke(args) -> None:
    import cma

    rng = np.random.default_rng(args.seed)
    target = rng.random(len(CONTINUOUS))  # the hidden best continuous vector
    x0 = np.clip(target + 0.25 * rng.standard_normal(len(CONTINUOUS)), 0.0, 1.0)
    obj = lambda x: float(np.mean((np.asarray(x) - target) ** 2))
    es = cma.CMAEvolutionStrategy(
        x0.tolist(), 0.2, {"bounds": [0.0, 1.0], "maxfevals": 3000, "seed": args.seed + 1, "verbose": -9}
    )
    while not es.stop():
        xs = es.ask()
        es.tell(xs, [obj(x) for x in xs])
    print(f"smoke CMA-ES: start {obj(x0):.4f} -> best {es.result.fbest:.6f} over {len(CONTINUOUS)} dims")
    assert es.result.fbest < 1e-3, f"smoke: CMA-ES did not converge ({es.result.fbest})"
    print("OK: CMA-ES neighborhood search converges")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", type=Path, help="target sound (wav) to match")
    ap.add_argument("--out", type=Path, help=".mnlgxdprog to write the refined patch")
    ap.add_argument("--model", type=Path, default=infer.DEFAULT_MODEL)
    ap.add_argument("--template", type=Path, default=infer.DEFAULT_TEMPLATE)
    ap.add_argument("--pitch", type=int, default=60, help="MIDI note to render the candidate patch")
    ap.add_argument("--detect-pitch", action="store_true",
                    help="render at the source's detected pitch (pyin) instead of --pitch")
    ap.add_argument("--gate", type=float, default=1.0)
    ap.add_argument("--duration", type=float, default=2.0)
    ap.add_argument("--settle", type=float, default=0.1)
    ap.add_argument("--threshold", type=float, default=0.0, help="skip CMA-ES if estimate distance <= this (0 = always refine)")
    ap.add_argument("--evals", type=int, default=140, help="CMA-ES objective calls (hardware renders)")
    ap.add_argument("--sigma", type=float, default=0.1, help="CMA-ES initial step (neighborhood width in [0,1])")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--search-discrete", action="store_true",
                    help="coordinate-search osc/filter/EG categorical params on the XD before continuous CMA-ES")
    ap.add_argument("--disc-groups", default=DEFAULT_DISC_GROUPS, help="comma-separated discrete group ids to search")
    ap.add_argument("--disc-topk", type=int, default=4, help="encoder top-k logit candidates per discrete group")
    ap.add_argument("--disc-passes", type=int, default=2, help="coordinate-descent passes over the discrete groups")
    ap.add_argument("--lowpass", type=float, default=None,
                    help="band-limit both signals before scoring (e.g. 8000 for 16 kHz NSynth targets)")
    ap.add_argument("--anchor-octave", action=argparse.BooleanOptionalAction, default=True,
                    help="force VCO octave to 8' (note sounds at its played pitch) instead of trusting the encoder")
    ap.add_argument("--accumulate", type=Path, default=None, help="dir to stash (params, audio) for proxy improvement")
    ap.add_argument("--midi-out", default="minilogue xd SOUND")
    ap.add_argument("--midi-in", default="minilogue xd KBD/KNOB")
    ap.add_argument("--audio", default="Volt 276")
    ap.add_argument("--smoke", action="store_true", help="synthetic CMA-ES convergence check (no hardware)")
    args = ap.parse_args()

    if args.smoke:
        _smoke(args)
        return
    if not args.target or not args.out:
        raise SystemExit("--target and --out are required (or use --smoke)")

    sr = schema.AUDIO["sample_rate"]
    session = infer.load_session(args.model)
    template = korg.extract_prog_bins(args.template)[0]
    target = infer.load_audio(args.target)
    pitch = detect_pitch_midi(target, sr) if args.detect_pitch else args.pitch
    if args.detect_pitch:
        print(f"detected source pitch -> MIDI {pitch}")
    xd = XdInterface(midi_port=args.midi_out, midi_in=args.midi_in, audio_device=args.audio, sample_rate=sr)
    try:
        def render(raw: dict[str, int]) -> np.ndarray:
            xd.send_patch(xd_params.write_params(template, raw), settle_s=args.settle)
            return xd.record(note=pitch, gate_s=args.gate, duration_s=args.duration)

        best_raw, best_d, best_audio = refine(
            target, session, template, render,
            threshold=args.threshold, evals=args.evals, sigma=args.sigma, seed=args.seed,
            search_discrete=args.search_discrete,
            disc_groups=tuple(g.strip() for g in args.disc_groups.split(",") if g.strip()),
            disc_topk=args.disc_topk, disc_passes=args.disc_passes, lowpass=args.lowpass,
            anchor_octave=args.anchor_octave,
        )
        korg.write_mnlgxdprog(args.template, xd_params.write_params(template, best_raw), args.out)
        print(f"wrote {args.out} (dist={best_d:.4f})")
        if args.accumulate:
            _accumulate(args.accumulate, best_raw, best_audio, sr)
            print(f"stashed refined sample -> {args.accumulate}")
    finally:
        xd.send_patch(template, settle_s=0.05)
        xd.close()


if __name__ == "__main__":
    main()
