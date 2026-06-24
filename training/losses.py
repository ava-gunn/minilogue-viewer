"""Multi-head loss for the sound-matching encoder, derived from the shared schema so the
head split can't drift from the model or the app.

  continuous : L1 on [0,1] (sigmoid outputs vs normalized raw targets)
  discrete   : cross-entropy per group — the concatenated [B, total_discrete] logits are
               split by cardinality, one CE against the group's target class index
  boolean    : BCE on [0,1]

Kept as three separate losses (never one flattened vector) so discrete and continuous
params get the right objective.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

from training import schema

# (offset, cardinality) per discrete group, in schema order.
_DISCRETE_SLICES: list[tuple[int, int]] = []
_offset = 0
for _card in schema.DISCRETE_CARDINALITIES:
    _DISCRETE_SLICES.append((_offset, _card))
    _offset += _card

Pred = tuple[torch.Tensor, torch.Tensor, torch.Tensor]
Target = tuple[torch.Tensor, torch.Tensor, torch.Tensor]


def multihead_loss(
    pred: Pred,
    target: Target,
    weights: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> tuple[torch.Tensor, dict[str, float]]:
    """pred = (continuous [B,n_cont] in [0,1], discrete [B,total_discrete] logits,
    boolean [B,n_bool] in [0,1]); target = (continuous [B,n_cont] float,
    discrete [B,n_discrete] long class indices, boolean [B,n_bool] float)."""
    cont_p, disc_p, bool_p = pred
    cont_t, disc_t, bool_t = target
    w_c, w_d, w_b = weights

    cont_loss = F.l1_loss(cont_p, cont_t)

    disc_loss = cont_p.new_zeros(())
    for group, (off, card) in enumerate(_DISCRETE_SLICES):
        disc_loss = disc_loss + F.cross_entropy(
            disc_p[:, off : off + card], disc_t[:, group]
        )
    if _DISCRETE_SLICES:
        disc_loss = disc_loss / len(_DISCRETE_SLICES)

    bool_loss = F.binary_cross_entropy(bool_p, bool_t)

    total = w_c * cont_loss + w_d * disc_loss + w_b * bool_loss
    parts = {
        "continuous": cont_loss.item(),
        "discrete": disc_loss.item(),
        "boolean": bool_loss.item(),
    }
    return total, parts
