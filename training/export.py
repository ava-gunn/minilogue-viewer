"""Export the sound-matching model to ONNX (opset 17) for onnxruntime-web.

    python -m training.export --dummy             # contract-shaped random model (no torch)
    python -m training.export --checkpoint run.pt # export a trained encoder (needs torch)

Run from the repo root. The dummy path builds the ONNX graph directly with `onnx` so the
browser integration can be exercised before any training exists; the real path lazily
imports torch + the encoder. Both write web/public/models/model.onnx and run an
onnxruntime self-check (every op must load + shapes must match the contract).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

from training import schema
from training.runtime import atomic_write_bytes

_REPO = Path(__file__).resolve().parent.parent
_OUT = _REPO / "web" / "public" / "models" / "model.onnx"
_OPSET = 17
# Pinned for compatibility with both onnxruntime (python) and onnxruntime-web.
_IR_VERSION = 10


def build_dummy() -> onnx.ModelProto:
    """A tiny, valid, input-dependent graph with the contract's I/O shapes.

    Feature = mean of the log-mel over the time axis -> [1, n_mels]; each head is a
    random-weight Gemm off that feature. Weights are meaningless (random) — this exists
    only to exercise the browser wire end to end before a trained model lands.
    """
    rng = np.random.default_rng(0)
    n_mels = schema.N_MELS
    nodes: list = []
    inits: list = []

    nodes.append(
        helper.make_node("ReduceMean", ["mel"], ["pooled"], axes=[3], keepdims=0, name="pool")
    )
    inits.append(numpy_helper.from_array(np.array([1, n_mels], dtype=np.int64), "feat_shape"))
    nodes.append(helper.make_node("Reshape", ["pooled", "feat_shape"], ["feature"], name="reshape"))

    def head(name: str, out_dim: int, activation: str | None) -> None:
        w = (rng.standard_normal((n_mels, out_dim)) * 0.1).astype(np.float32)
        b = (rng.standard_normal((out_dim,)) * 0.1).astype(np.float32)
        inits.append(numpy_helper.from_array(w, f"{name}_w"))
        inits.append(numpy_helper.from_array(b, f"{name}_b"))
        raw = name if activation is None else f"{name}_logit"
        nodes.append(
            helper.make_node("Gemm", ["feature", f"{name}_w", f"{name}_b"], [raw], name=f"{name}_gemm")
        )
        if activation is not None:
            nodes.append(helper.make_node(activation, [raw], [name], name=f"{name}_act"))

    head("continuous", schema.N_CONTINUOUS, "Sigmoid")
    head("discrete", schema.TOTAL_DISCRETE, None)  # logits; argmax per group at decode
    head("boolean", schema.N_BOOLEAN, "Sigmoid")

    inp = helper.make_tensor_value_info("mel", TensorProto.FLOAT, list(schema.INPUT_SHAPE))
    outs = [
        helper.make_tensor_value_info("continuous", TensorProto.FLOAT, [1, schema.N_CONTINUOUS]),
        helper.make_tensor_value_info("discrete", TensorProto.FLOAT, [1, schema.TOTAL_DISCRETE]),
        helper.make_tensor_value_info("boolean", TensorProto.FLOAT, [1, schema.N_BOOLEAN]),
    ]
    graph = helper.make_graph(nodes, "minilogue_xd_sound_match_dummy", [inp], outs, inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", _OPSET)])
    model.ir_version = _IR_VERSION
    onnx.checker.check_model(model)
    return model


def build_real(checkpoint: Path) -> None:
    import torch

    from training.model.encoder import SoundMatchEncoder

    model = SoundMatchEncoder()
    model.load_state_dict(torch.load(checkpoint, map_location="cpu"))
    model.eval()
    sample = torch.zeros(schema.INPUT_SHAPE, dtype=torch.float32)
    _OUT.parent.mkdir(parents=True, exist_ok=True)
    # Export to a temp path then rename, so the browser (or a self-check) never reads a
    # half-written model — e.g. a retrain re-exporting while the app fetches it.
    tmp = _OUT.with_name(_OUT.name + ".tmp")
    torch.onnx.export(
        model,
        sample,
        str(tmp),
        input_names=[schema.INPUT_NAME],
        output_names=list(schema.OUTPUT_NAMES),
        opset_version=_OPSET,
        # Pin the legacy TorchScript exporter — known-good for opset 17 + onnxruntime-web.
        # torch 2.9 flips the default to the dynamo exporter; don't let that change silently.
        dynamo=False,
    )
    tmp.replace(_OUT)


def self_check() -> None:
    sess = ort.InferenceSession(str(_OUT), providers=["CPUExecutionProvider"])
    x = np.zeros(schema.INPUT_SHAPE, dtype=np.float32)
    outs = sess.run(None, {schema.INPUT_NAME: x})
    shapes = {o.name: list(t.shape) for o, t in zip(sess.get_outputs(), outs)}
    expected = {
        "continuous": [1, schema.N_CONTINUOUS],
        "discrete": [1, schema.TOTAL_DISCRETE],
        "boolean": [1, schema.N_BOOLEAN],
    }
    assert shapes == expected, f"shape mismatch: {shapes} != {expected}"
    print("self-check ok:", shapes)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--dummy", action="store_true", help="random contract-shaped model")
    group.add_argument("--checkpoint", type=Path, help="trained encoder state_dict (.pt)")
    args = ap.parse_args()

    _OUT.parent.mkdir(parents=True, exist_ok=True)
    if args.dummy:
        atomic_write_bytes(_OUT, build_dummy().SerializeToString())
    else:
        build_real(args.checkpoint)
    self_check()
    print(f"wrote {_OUT}")


if __name__ == "__main__":
    main()
