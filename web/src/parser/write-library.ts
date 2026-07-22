import { strToU8, zipSync } from 'fflate'

// Serialize raw 1024-byte prog_bin blobs into a valid Korg minilogue xd `.mnlgxdlib` archive — a
// flat ZIP of Prog_NNN.prog_bin + a matching Prog_NNN.prog_info per program + a FileInformation.xml
// manifest. Favorite/tuning tables are omitted (counts 0): they index bank slots, which are
// meaningless for an arbitrary exported subset. Structure verified against real Korg fixtures.

const PROG_INFO =
  '<?xml version="1.0" encoding="UTF-8"?>\n\n' +
  '<xd_ProgramInformation>\n  <Programmer></Programmer>\n  <Comment></Comment>\n</xd_ProgramInformation>\n'

function fileInformation(count: number): string {
  const programs = Array.from({ length: count }, (_, i) => {
    const nnn = String(i).padStart(3, '0')
    return (
      '    <ProgramData>\n' +
      `      <Information>Prog_${nnn}.prog_info</Information>\n` +
      `      <ProgramBinary>Prog_${nnn}.prog_bin</ProgramBinary>\n` +
      '    </ProgramData>'
    )
  }).join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n\n' +
    '<KorgMSLibrarian_Data>\n  <Product>minilogue xd</Product>\n' +
    `  <Contents NumFavoriteData="0" NumProgramData="${count}" NumPresetInformation="0" NumTuneScaleData="0" NumTuneOctData="0">\n` +
    `${programs}\n` +
    '  </Contents>\n</KorgMSLibrarian_Data>\n'
  )
}

/** Build a `.mnlgxdlib` archive (bytes) from raw prog_bin blobs, renumbered contiguously from 000. */
export function buildLibrary(bins: Uint8Array[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  bins.forEach((bin, i) => {
    const nnn = String(i).padStart(3, '0')
    files[`Prog_${nnn}.prog_bin`] = bin
    files[`Prog_${nnn}.prog_info`] = strToU8(PROG_INFO)
  })
  files['FileInformation.xml'] = strToU8(fileInformation(bins.length))
  return zipSync(files)
}
