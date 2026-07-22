import { strFromU8, unzipSync } from 'fflate'
import { expect, it } from 'vitest'
import { extractProgramBins } from './unzip'
import { buildLibrary } from './write-library'

const bin = (fill: number): Uint8Array => new Uint8Array(1024).fill(fill)

it('round-trips through extractProgramBins with bytes preserved', () => {
  const bins = [bin(1), bin(2), bin(3)]
  const out = extractProgramBins(buildLibrary(bins))
  expect(out).toHaveLength(3)
  out.forEach((b, i) => {
    expect([...b]).toEqual([...bins[i]])
  })
})

it('emits contiguous programs + a matching FileInformation manifest', () => {
  const files = unzipSync(buildLibrary([bin(0), bin(0)]))
  const names = Object.keys(files)
  expect(names).toContain('Prog_000.prog_bin')
  expect(names).toContain('Prog_001.prog_bin')
  expect(names).toContain('Prog_000.prog_info')
  const info = strFromU8(files['FileInformation.xml'])
  expect(info).toContain('minilogue xd')
  expect(info).toContain('NumProgramData="2"')
  expect(info).toContain('<ProgramBinary>Prog_001.prog_bin</ProgramBinary>')
  expect(info).toContain('NumFavoriteData="0"')
})

it('handles an empty selection without crashing', () => {
  const info = strFromU8(unzipSync(buildLibrary([]))['FileInformation.xml'])
  expect(info).toContain('NumProgramData="0"')
})
