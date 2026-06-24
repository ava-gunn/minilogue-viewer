import { unzipSync } from 'fflate'

const PROG_BIN = /(?:^|\/)Prog_\d{3}\.prog_bin$/

/**
 * Extract the program binaries from a .mnlgxdprog / .mnlgxdlib archive, sorted
 * by program index. A single .mnlgxdprog yields one; a .mnlgxdlib yields many.
 */
export function extractProgramBins(data: Uint8Array): Uint8Array[] {
  const files = unzipSync(data)
  return Object.keys(files)
    .filter((name) => PROG_BIN.test(name))
    .sort()
    .map((name) => files[name])
}
