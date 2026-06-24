// Decode an audio file to the fixed-length mono signal the model expects. An
// OfflineAudioContext does decode + resample + downmix-to-mono + crop/pad to N_SAMPLES
// in a single render pass (the source buffer is resampled to the context rate).

import { N_SAMPLES, SAMPLE_RATE } from './contract'

export async function decodeToSamples(file: File): Promise<Float32Array> {
  const data = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(1, N_SAMPLES, SAMPLE_RATE)
  const decoded = await ctx.decodeAudioData(data)
  const source = ctx.createBufferSource()
  source.buffer = decoded
  source.connect(ctx.destination)
  source.start()
  const rendered = await ctx.startRendering()
  return rendered.getChannelData(0)
}
