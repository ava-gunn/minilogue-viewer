import type { MinilogueXDPatch } from '../types/synth'
import { readRawPatch } from './binary'
import { hashProgBin } from './hash'
import { parsePatch } from './patch'
import { validatePatch } from './schema'
import { extractProgramBins } from './unzip'

export type { RawPatch } from './binary'

/** Parse + validate a single 1024-byte prog_bin into a domain patch. */
export function parseProgramBin(bytes: Uint8Array): MinilogueXDPatch {
  return validatePatch(parsePatch(readRawPatch(bytes)))
}

/** Parse every program in a .mnlgxdprog / .mnlgxdlib archive. */
export function parseArchive(data: Uint8Array): MinilogueXDPatch[] {
  return extractProgramBins(data).map(parseProgramBin)
}

/** A parsed program paired with a stable content-hash key (for rating persistence). */
export interface LibraryEntry {
  patch: MinilogueXDPatch
  key: string
}

/** Parse an archive, pairing each program with a stable key derived from its raw bytes. */
export function parseLibrary(data: Uint8Array): LibraryEntry[] {
  return extractProgramBins(data).map((bytes) => ({
    patch: parseProgramBin(bytes),
    key: hashProgBin(bytes),
  }))
}
