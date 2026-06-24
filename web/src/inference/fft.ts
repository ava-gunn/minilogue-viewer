// In-place iterative radix-2 Cooley–Tukey FFT. Length must be a power of two
// (n_fft = 2048). Operates on parallel real/imaginary Float32Arrays.

export function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (-2 * Math.PI) / len
    const wStepRe = Math.cos(ang)
    const wStepIm = Math.sin(ang)
    for (let start = 0; start < n; start += len) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < half; k++) {
        const a = start + k
        const b = a + half
        const vRe = re[b] * wRe - im[b] * wIm
        const vIm = re[b] * wIm + im[b] * wRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const nextRe = wRe * wStepRe - wIm * wStepIm
        wIm = wRe * wStepIm + wIm * wStepRe
        wRe = nextRe
      }
    }
  }
}
