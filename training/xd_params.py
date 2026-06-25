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


def _write_raw(buf: bytearray, offset: int, width: int, value: int) -> None:
    if width == 8:
        buf[offset] = value & 0xFF
    else:  # 10-bit little-endian; preserve the unused high bits
        buf[offset] = value & 0xFF
        buf[offset + 1] = (buf[offset + 1] & 0xFC) | ((value >> 8) & 0x03)


def _targets(raw_by_id: dict[str, int]) -> dict:
    return {
        "continuous": [raw_by_id[p["id"]] / p["raw_max"] for p in schema.CONTINUOUS],
        "discrete": [raw_by_id[p["id"]] for p in schema.DISCRETE],
        "boolean": [float(raw_by_id[p["id"]]) for p in schema.BOOLEAN],
    }


def randomize(template: bytes, rng: np.random.Generator) -> tuple[bytes, dict]:
    """Return (randomized prog_bin, target vectors). Starts from a valid template and
    overwrites only the param-region bytes, so structure/header/sequence stay intact."""
    buf = bytearray(template)
    raw_by_id: dict[str, int] = {}
    for p in schema.PARAMS:
        if p["id"] == "voice_mode":
            value = _VOICE_MODE_POLY
        elif p["type"] == "continuous":
            value = int(rng.integers(0, p["raw_max"] + 1))
        elif p["type"] == "discrete":
            value = int(rng.integers(0, p["cardinality"]))
        else:  # boolean
            value = int(rng.integers(0, 2))
        _write_raw(buf, p["byte_offset"], p["bit_width"], value)
        raw_by_id[p["id"]] = value
    return bytes(buf), _targets(raw_by_id)
