"""Read/write Minilogue XD program-data params per the shared schema, and Sobol-sample
patches by overwriting the param region of a valid template prog_bin.

Mirrors the TS parser's raw extraction (10-bit little-endian, masked to 10 bits). Targets
are emitted in the model's head layout (schema.CONTINUOUS / DISCRETE / BOOLEAN order):
continuous normalized to [0,1] by raw_max, discrete as class indices, boolean as 0/1 —
the label format stored alongside each recorded clip in the (params, audio) sweep dataset.

voice_mode is held at POLY (raw 4): ARP (raw 0/1)/CHORD/UNISON turn one held note into a
sequence or chord, which would break the single-sustained-note timbre assumption.
"""

from __future__ import annotations

import warnings

import numpy as np
from scipy.stats.qmc import Sobol

from training import schema

# Korg MIDI Impl: VOICE MODE TYPE @21 is 0=ARP LATCH, 1=ARP, 2=CHORD, 3=UNISON, 4=POLY.
# POLY is 4, NOT 0 — forcing 0 latches the arpeggiator and re-triggers every note.
_VOICE_MODE_POLY = 4

# Audible sub-ranges: confine these continuous params to a fraction of raw_max so sampled
# patches reliably make sound and their oscillators are on — which makes their params
# identifiable from the audio (the encoder only ever targets audible sounds, so silent
# patches are wasted hardware time). Levels/cutoff get a floor; amp attack gets a cap so
# the note isn't still ramping when the window ends. Disable with audible=False for pure
# uniform coverage of the whole space.
_BIAS: dict[str, tuple[float, float]] = {
    "mixer_vco1": (0.15, 1.0),
    "mixer_vco2": (0.15, 1.0),
    "mixer_multi": (0.15, 1.0),
    "cutoff": (0.15, 1.0),
    "amp_attack": (0.0, 0.7),
}


def _write_raw(buf: bytearray, offset: int, width: int, value: int) -> None:
    if width == 8:
        buf[offset] = value & 0xFF
    else:  # 10-bit little-endian; preserve the unused high bits
        buf[offset] = value & 0xFF
        buf[offset + 1] = (buf[offset + 1] & 0xFC) | ((value >> 8) & 0x03)


def _read_raw(buf: bytes, offset: int, width: int) -> int:
    if width == 8:
        return buf[offset]
    return buf[offset] | ((buf[offset + 1] & 0x03) << 8)  # 10-bit little-endian


def read_params(prog_bin: bytes) -> dict[str, int]:
    """Extract raw param values by id from a prog_bin — the inverse of write_params, and the
    same raw extraction the TS parser does (8-bit direct; 10-bit little-endian masked to 10
    bits). Used to label factory presets with their ground-truth params for eval."""
    return {p["id"]: _read_raw(prog_bin, p["byte_offset"], p["bit_width"]) for p in schema.PARAMS}


def _targets(raw_by_id: dict[str, int]) -> dict:
    return {
        "continuous": [raw_by_id[p["id"]] / p["raw_max"] for p in schema.CONTINUOUS],
        "discrete": [raw_by_id[p["id"]] for p in schema.DISCRETE],
        "boolean": [float(raw_by_id[p["id"]]) for p in schema.BOOLEAN],
    }


def targets_for(raw_by_id: dict[str, int]) -> dict:
    """Public view of a raw-param dict in the model's head layout (continuous normalized,
    discrete indices, boolean 0/1) — used to stash a refined patch back into the proxy set."""
    return _targets(raw_by_id)


def clamp_params(raw_by_id: dict[str, int]) -> dict[str, int]:
    """Clamp untrusted raw values to each param's schema range (continuous -> [0,raw_max],
    discrete -> [0,cardinality), boolean -> {0,1}) and pin voice_mode to POLY. Used before
    realizing a *submitted* patch on hardware so an out-of-range or ARP/high-resonance patch
    can't be driven onto the synth."""
    out: dict[str, int] = {}
    for p in schema.PARAMS:
        if p["id"] not in raw_by_id:
            continue
        v = int(raw_by_id[p["id"]])
        if p["type"] == "continuous":
            v = max(0, min(p["raw_max"], v))
        elif p["type"] == "discrete":
            v = max(0, min(p["cardinality"] - 1, v))
        else:  # boolean
            v = 1 if v else 0
        out[p["id"]] = v
    out["voice_mode"] = _VOICE_MODE_POLY
    return out


def write_params(template: bytes, raw_by_id: dict[str, int]) -> bytes:
    """Overwrite a valid template prog_bin's param-region bytes with raw values (by param
    id), leaving structure/header/sequence intact. Inverse of the TS parser's raw
    extraction; used by randomize() and by the eval harness to realize a predicted patch."""
    buf = bytearray(template)
    for p in schema.PARAMS:
        if p["id"] in raw_by_id:
            _write_raw(buf, p["byte_offset"], p["bit_width"], raw_by_id[p["id"]])
    return bytes(buf)


def sobol_unit(n_patches: int, seed: int = 0) -> np.ndarray:
    """Low-discrepancy unit-hypercube samples — [n_patches, len(schema.PARAMS)] in [0,1),
    one row per patch, one column per param in schema.PARAMS order. Scrambled + seeded so a
    run is reproducible and resumable: regenerate the sequence, skip the rows already done.
    Sobol balance is best at power-of-2 counts (the imbalance warning is harmless here)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return Sobol(d=len(schema.PARAMS), scramble=True, seed=seed).random(n_patches)


def sample(template: bytes, u: np.ndarray, audible: bool = True) -> tuple[bytes, dict]:
    """Map one unit-hypercube row (a sobol_unit row) to a patch: continuous -> raw via
    raw_max (remapped into its audible sub-range when audible), discrete -> class index,
    boolean -> {0,1}; voice_mode pinned to POLY. Returns (prog_bin, target vectors). Starts
    from a valid template and overwrites only the param-region bytes, so structure/header/
    sequence stay intact."""
    raw_by_id: dict[str, int] = {}
    for j, p in enumerate(schema.PARAMS):
        x = float(u[j])
        if p["id"] == "voice_mode":
            value = _VOICE_MODE_POLY
        elif p["type"] == "continuous":
            lo_f, hi_f = _BIAS.get(p["id"], (0.0, 1.0)) if audible else (0.0, 1.0)
            value = int(round((lo_f + x * (hi_f - lo_f)) * p["raw_max"]))
            value = max(0, min(p["raw_max"], value))
        elif p["type"] == "discrete":
            value = min(p["cardinality"] - 1, int(x * p["cardinality"]))
        else:  # boolean
            value = int(x >= 0.5)
        raw_by_id[p["id"]] = value
    return write_params(template, raw_by_id), _targets(raw_by_id)


if __name__ == "__main__":  # hardware-free self-check of the Sobol sampler
    n = 256
    template = bytes(1024)  # write_params only touches param-region offsets
    assert np.array_equal(sobol_unit(n, 0), sobol_unit(n, 0)), "must be deterministic per seed"
    u = sobol_unit(n, 0)
    assert u.shape == (n, len(schema.PARAMS))
    spans = {p["id"]: [1.0, 0.0] for p in schema.CONTINUOUS}
    for row in u:
        prog_bin, targets = sample(template, row, audible=True)
        raw = read_params(prog_bin)
        for p in schema.PARAMS:  # round-trips through the prog_bin bytes
            assert raw[p["id"]] == _read_raw(write_params(template, raw), p["byte_offset"], p["bit_width"])
        assert raw["voice_mode"] == _VOICE_MODE_POLY
        for p in schema.CONTINUOUS:
            v = raw[p["id"]]
            assert 0 <= v <= p["raw_max"]
            lo_f, hi_f = _BIAS.get(p["id"], (0.0, 1.0))
            assert v >= int(lo_f * p["raw_max"]) and v <= int(round(hi_f * p["raw_max"]))
            norm = v / p["raw_max"]
            spans[p["id"]][0] = min(spans[p["id"]][0], norm)
            spans[p["id"]][1] = max(spans[p["id"]][1], norm)
        for p in schema.DISCRETE:
            assert 0 <= raw[p["id"]] < p["cardinality"]
        for p in schema.BOOLEAN:
            assert raw[p["id"]] in (0, 1)
    worst = min((hi - lo) for lo, hi in spans.values())
    print(f"OK: {n} Sobol patches, {len(schema.PARAMS)} dims, voice_mode=POLY, all in range")
    print(f"   continuous coverage: tightest param spans {worst:.2f} of its (sub-)range")
