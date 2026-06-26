"""Flatten the multi-head param representation into one fixed-length vector — the proxy's
input and the bridge to the encoder in end-to-end training.

Layout (length VEC_DIM): continuous [N_CONTINUOUS] ++ one-hot per discrete group
[TOTAL_DISCRETE] ++ boolean [N_BOOLEAN]. Discrete is one-hot (not an ordinal index) so the
proxy doesn't read categorical wave/filter types as an ordered scale. This deliberately
mirrors the encoder's output heads (continuous sigmoid | discrete logits | boolean
sigmoid), so in Stage 3 the encoder's outputs feed straight into the proxy with a per-group
softmax standing in for argmax — keeping the whole path differentiable.
"""

from __future__ import annotations

import numpy as np

from training import schema

VEC_DIM = schema.N_CONTINUOUS + schema.TOTAL_DISCRETE + schema.N_BOOLEAN

# Start offset of each discrete group inside the one-hot block.
_DISC_OFFSETS = np.cumsum([0, *schema.DISCRETE_CARDINALITIES[:-1]]).tolist()


def targets_to_vector(targets: dict) -> np.ndarray:
    """A samples.jsonl row's {continuous:[0,1]…, discrete:[idx]…, boolean:[0/1]…} -> a
    VEC_DIM float32 vector with each discrete group one-hot encoded."""
    cont = np.asarray(targets["continuous"], dtype=np.float32)
    boolean = np.asarray(targets["boolean"], dtype=np.float32)
    disc = np.zeros(schema.TOTAL_DISCRETE, dtype=np.float32)
    for off, idx in zip(_DISC_OFFSETS, targets["discrete"]):
        disc[off + int(idx)] = 1.0
    return np.concatenate([cont, disc, boolean])


if __name__ == "__main__":
    from training import xd_params

    _, targets = xd_params.sample(bytes(1024), xd_params.sobol_unit(1, 0)[0])
    v = targets_to_vector(targets)
    assert v.shape == (VEC_DIM,), v.shape
    nc, td = schema.N_CONTINUOUS, schema.TOTAL_DISCRETE
    assert np.allclose(v[:nc], targets["continuous"])
    assert v[nc : nc + td].sum() == len(schema.DISCRETE), "one 1 per discrete group"
    assert np.allclose(v[nc + td :], targets["boolean"])
    print(f"OK: VEC_DIM={VEC_DIM} (continuous={nc} + one-hot discrete={td} + boolean={schema.N_BOOLEAN})")
