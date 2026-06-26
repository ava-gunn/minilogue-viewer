// Model I/O contract; layout must match training/schema.py (derived from the same JSON).
//   input  `mel`        float32 [1, 1, N_MELS, N_FRAMES]   (log-mel spectrogram)
//   output `continuous` float32 [1, n_continuous]          sigmoid, raw value / rawMax
//   output `discrete`   float32 [1, total_discrete]         per-param logit groups
//   output `boolean`    float32 [1, n_boolean]             sigmoid, threshold at 0.5

import {
  AUDIO_SPEC,
  type BooleanSpec,
  type ContinuousSpec,
  type DiscreteSpec,
  PARAM_SPEC,
} from '../parser/param-spec'

// Ordering is significant: heads are laid out in spec order on both sides.
export const continuousParams = PARAM_SPEC.filter(
  (s): s is ContinuousSpec => s.type === 'continuous',
)
export const discreteParams = PARAM_SPEC.filter(
  (s): s is DiscreteSpec => s.type === 'discrete',
)
export const booleanParams = PARAM_SPEC.filter(
  (s): s is BooleanSpec => s.type === 'boolean',
)

export const SAMPLE_RATE = AUDIO_SPEC.sample_rate
export const N_FFT = AUDIO_SPEC.n_fft
export const HOP_LENGTH = AUDIO_SPEC.hop_length
export const N_MELS = AUDIO_SPEC.n_mels
export const FMIN = AUDIO_SPEC.fmin
export const FMAX = AUDIO_SPEC.fmax

export const N_SAMPLES = Math.floor(SAMPLE_RATE * AUDIO_SPEC.duration_s)
// center=False framing — must match training/schema.py's N_FRAMES.
export const N_FRAMES = 1 + Math.floor((N_SAMPLES - N_FFT) / HOP_LENGTH)

export const TOTAL_DISCRETE = discreteParams.reduce(
  (sum, p) => sum + p.cardinality,
  0,
)

export const INPUT_NAME = 'mel'
export const OUTPUT_NAMES = ['continuous', 'discrete', 'boolean'] as const
