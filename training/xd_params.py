"""Read/write Minilogue XD program-data params per the shared schema, and randomize a
patch by overwriting the param region of a valid template prog_bin.

Mirrors the TS parser's raw extraction (10-bit little-endian, masked to 10 bits). Targets
are emitted in the model's head layout (schema.CONTINUOUS / DISCRETE / BOOLEAN order):
continuous normalized to [0,1] by raw_max, discrete as class indices, boolean as 0/1 —
exactly what training/losses.py expects.

voice_mode is held at POLY (index 0): ARP/CHORD/UNISON turn one held note into a sequence
or chord, which would break the single-sustained-note timbre assumption.
"""

from __future__ import annotations

import numpy as np

from training import schema

_VOICE_MODE_POLY = 0

# Audible biasing: sample these continuous params from a sub-range (fraction of raw_max)
# so random patches reliably make sound and their oscillators are on — which makes their
# params identifiable from the audio. Levels/cutoff get a floor; amp attack gets a cap so
# the note isn't still ramping when the window ends.
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


def write_params(template: bytes, raw_by_id: dict[str, int]) -> bytes:
    """Overwrite a valid template prog_bin's param-region bytes with raw values (by param
    id), leaving structure/header/sequence intact. Inverse of the TS parser's raw
    extraction; used by randomize() and by the eval harness to realize a predicted patch."""
    buf = bytearray(template)
    for p in schema.PARAMS:
        if p["id"] in raw_by_id:
            _write_raw(buf, p["byte_offset"], p["bit_width"], raw_by_id[p["id"]])
    return bytes(buf)


def randomize(template: bytes, rng: np.random.Generator) -> tuple[bytes, dict]:
    """Return (randomized prog_bin, target vectors). Starts from a valid template and
    overwrites only the param-region bytes, so structure/header/sequence stay intact."""
    raw_by_id: dict[str, int] = {}
    for p in schema.PARAMS:
        if p["id"] == "voice_mode":
            value = _VOICE_MODE_POLY
        elif p["type"] == "continuous":
            lo_f, hi_f = _BIAS.get(p["id"], (0.0, 1.0))
            value = int(rng.integers(int(lo_f * p["raw_max"]), int(hi_f * p["raw_max"]) + 1))
        elif p["type"] == "discrete":
            value = int(rng.integers(0, p["cardinality"]))
        else:  # boolean
            value = int(rng.integers(0, 2))
        raw_by_id[p["id"]] = value
    return write_params(template, raw_by_id), _targets(raw_by_id)
