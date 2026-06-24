"""Load the shared parameter + audio schema (generated from the TS app's param-spec)
and derive the model's I/O contract.

This is the Python half of the single source of truth: the TS app generates
schema/*.json from web/src/parser/param-spec.ts, and both the browser inference layer
(web/src/inference/contract.ts) and this module derive head ordering/sizes from it, so
the model's output indices always map to the right parameters.
"""

from __future__ import annotations

import json
from pathlib import Path

_SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"


def _load(name: str) -> dict:
    return json.loads((_SCHEMA_DIR / name).read_text())


PARAMS_SCHEMA = _load("minilogue-xd.params.json")
AUDIO = _load("audio.json")

PARAMS: list[dict] = PARAMS_SCHEMA["parameters"]
# Ordering is significant: heads are laid out in schema order on both sides.
CONTINUOUS = [p for p in PARAMS if p["type"] == "continuous"]
DISCRETE = [p for p in PARAMS if p["type"] == "discrete"]
BOOLEAN = [p for p in PARAMS if p["type"] == "boolean"]

N_CONTINUOUS = len(CONTINUOUS)
N_BOOLEAN = len(BOOLEAN)
DISCRETE_CARDINALITIES = [p["cardinality"] for p in DISCRETE]
TOTAL_DISCRETE = sum(DISCRETE_CARDINALITIES)

# Mel input. center=False framing; must match web/src/inference/contract.ts.
N_MELS = AUDIO["n_mels"]
N_SAMPLES = int(AUDIO["sample_rate"] * AUDIO["duration_s"])
N_FRAMES = 1 + (N_SAMPLES - AUDIO["n_fft"]) // AUDIO["hop_length"]
INPUT_SHAPE = (1, 1, N_MELS, N_FRAMES)

INPUT_NAME = "mel"
OUTPUT_NAMES = ("continuous", "discrete", "boolean")


if __name__ == "__main__":
    print(f"params: {len(PARAMS)} "
          f"(continuous={N_CONTINUOUS}, discrete={len(DISCRETE)}/{TOTAL_DISCRETE} logits, "
          f"boolean={N_BOOLEAN})")
    print(f"input: {INPUT_NAME} {INPUT_SHAPE}")
    print(f"outputs: {OUTPUT_NAMES}")
