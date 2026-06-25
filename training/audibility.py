"""Per-param audibility weights for the multi-head loss.

A param should only train when it's actually audible in the sample: VCO1/VCO2/MULTI
detail params (wave, pitch, shape, sync, ring, sub-engine select/shape) are inaudible
when that section's mixer level is ~0, so the loss weights them by that level. Everything
else (cutoff, resonance, amp EG, the mixer levels themselves, octave, FX) is always-on.

This keeps the model from wasting capacity fitting unidentifiable random targets — and
makes the reported metric reflect the params the audio actually constrains. Weights are
derived from the continuous targets, so no extra labels are stored.
"""

from __future__ import annotations

import torch

from training import schema

_CONT_IDS = [p["id"] for p in schema.CONTINUOUS]
_DISC_IDS = [p["id"] for p in schema.DISCRETE]
_BOOL_IDS = [p["id"] for p in schema.BOOLEAN]

# param id -> id of the mixer level that gates it (None = always audible)
_GATE: dict[str, str] = {}
for _id in ("vco1_wave", "vco1_octave", "vco1_pitch", "vco1_shape"):
    _GATE[_id] = "mixer_vco1"
for _id in ("vco2_wave", "vco2_octave", "vco2_pitch", "vco2_shape", "cross_mod_depth", "sync", "ring"):
    _GATE[_id] = "mixer_vco2"
for _id in (
    "multi_type", "multi_select_noise", "multi_select_vpm", "multi_select_user",
    "multi_shape_noise", "multi_shape_vpm", "multi_shape_user",
    "multi_shift_shape_noise", "multi_shift_shape_vpm", "multi_shift_shape_user",
):
    _GATE[_id] = "mixer_multi"

_FLOOR = 0.05  # keep a faint anchor so gated params don't drift arbitrarily
_MIX = {name: _CONT_IDS.index(name) for name in ("mixer_vco1", "mixer_vco2", "mixer_multi")}


def _weights_for(ids: list[str], gates: dict[str, torch.Tensor], batch: int, device) -> torch.Tensor:
    ones = torch.ones(batch, device=device)
    cols = [gates[_GATE[i]] if i in _GATE else ones for i in ids]
    return torch.stack(cols, dim=1).clamp(min=_FLOOR)


def weights(cont_target: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """cont_target [B, n_cont] -> (cont_w [B,n_cont], disc_w [B,n_disc], bool_w [B,n_bool])."""
    b, device = cont_target.shape[0], cont_target.device
    gates = {name: cont_target[:, idx] for name, idx in _MIX.items()}
    return (
        _weights_for(_CONT_IDS, gates, b, device),
        _weights_for(_DISC_IDS, gates, b, device),
        _weights_for(_BOOL_IDS, gates, b, device),
    )
