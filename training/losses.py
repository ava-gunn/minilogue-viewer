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
Masks = tuple[torch.Tensor, torch.Tensor, torch.Tensor]


def multihead_loss(
    pred: Pred,
    target: Target,
    weights: tuple[float, float, float] = (1.0, 1.0, 1.0),
    masks: Masks | None = None,
) -> tuple[torch.Tensor, dict[str, float]]:
    """pred = (continuous [B,n_cont] in [0,1], discrete [B,total_discrete] logits,
    boolean [B,n_bool] in [0,1]); target = (continuous [B,n_cont] float,
    discrete [B,n_discrete] long class indices, boolean [B,n_bool] float).

    masks (optional) = per-param audibility weights (cont_w, disc_w, bool_w); when given,
    each head becomes a weight-normalized average so inaudible params don't dominate."""
    cont_p, disc_p, bool_p = pred
    cont_t, disc_t, bool_t = target
    w_c, w_d, w_b = weights
    cont_w, disc_w, bool_w = (None, None, None) if masks is None else masks

    if cont_w is None:
        cont_loss = F.l1_loss(cont_p, cont_t)
    else:
        cont_loss = (cont_w * (cont_p - cont_t).abs()).sum() / cont_w.sum()

    disc_num = cont_p.new_zeros(())
    disc_den = cont_p.new_zeros(())
    for group, (off, card) in enumerate(_DISCRETE_SLICES):
        ce = F.cross_entropy(
            disc_p[:, off : off + card],
            disc_t[:, group],
            reduction="mean" if disc_w is None else "none",
        )
        if disc_w is None:
            disc_num = disc_num + ce
        else:
            disc_num = disc_num + (disc_w[:, group] * ce).sum()
            disc_den = disc_den + disc_w[:, group].sum()
    disc_loss = disc_num / (len(_DISCRETE_SLICES) if disc_w is None else disc_den)

    if bool_w is None:
        bool_loss = F.binary_cross_entropy(bool_p, bool_t)
    else:
        bce = F.binary_cross_entropy(bool_p, bool_t, reduction="none")
        bool_loss = (bool_w * bce).sum() / bool_w.sum()

    total = w_c * cont_loss + w_d * disc_loss + w_b * bool_loss
    parts = {
        "continuous": cont_loss.item(),
        "discrete": disc_loss.item(),
        "boolean": bool_loss.item(),
    }
    return total, parts
