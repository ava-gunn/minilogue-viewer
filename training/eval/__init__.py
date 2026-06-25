"""Real-world resynthesis evaluation.

Feed real single-note C4 audio through the sound-matching model, realize the predicted
program on the Minilogue XD (or use pre-recorded renders), record it, and score the
recording against the original — using the model's own log-mel so the distance is in the
same space the encoder sees.

Each clip is a single pitch-labeled note (no same-instrument-across-octaves requirement);
the XD is played at the clip's own pitch when scoring.

  build_eval_set.py — assemble a single-note set (NSynth pitch filter + your own clips)
  infer.py          — audio -> model -> prog_bin / .mnlgxdprog (mirrors the browser path)
  metrics.py        — log-mel / MFCC / multi-scale-STFT distances
  run_eval.py       — the loop: predict -> (hardware | pre-recorded) -> score -> report
"""
