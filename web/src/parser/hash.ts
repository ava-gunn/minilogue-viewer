/** Stable content id for a 1024-byte program: cyrb53 over the raw prog_bin bytes. Used as the
 * persistence key for per-patch star ratings — survives file rename/reorder (the bytes don't move)
 * and distinguishes patches that share a name. Renaming a patch changes its bytes, hence its key. */
export function hashProgBin(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i]
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  // 53-bit unsigned -> base36 keeps the key short.
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
