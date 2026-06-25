// Reads a 1024-byte prog_bin blob into raw integer fields. Offsets are from the
// Korg minilogue xd program data structure (gekart gist + oxur crate).

export interface RawPatch {
  name: string
  octave: number
  portamento: number
  voiceModeDepth: number
  voiceModeType: number
  vco1Wave: number
  vco1Octave: number
  vco1Pitch: number
  vco1Shape: number
  vco2Wave: number
  vco2Octave: number
  vco2Pitch: number
  vco2Shape: number
  sync: number
  ring: number
  crossModDepth: number
  multiType: number
  selectNoise: number
  selectVPM: number
  selectUser: number
  shapeNoise: number
  shapeVPM: number
  shapeUser: number
  shiftShapeNoise: number
  shiftShapeVPM: number
  shiftShapeUser: number
  vco1Level: number
  vco2Level: number
  multiLevel: number
  cutoff: number
  resonance: number
  cutoffDrive: number
  cutoffKeyTrack: number
  ampAttack: number
  ampDecay: number
  ampSustain: number
  ampRelease: number
  egAttack: number
  egDecay: number
  egInt: number
  egTarget: number
  lfoWave: number
  lfoMode: number
  lfoRate: number
  lfoInt: number
  lfoTarget: number
  modFxOn: number
  modFxType: number
  modFxTime: number
  modFxDepth: number
  delayOn: number
  delayTime: number
  delayDepth: number
  reverbOn: number
  reverbTime: number
  reverbDepth: number
}

const PROG_MAGIC = 'PROG'
const SYNTH_BLOCK_SIZE = 156

export function readRawPatch(bytes: Uint8Array): RawPatch {
  if (bytes.length < SYNTH_BLOCK_SIZE) {
    throw new Error(`prog_bin too short: ${bytes.length} bytes`)
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== PROG_MAGIC) {
    throw new Error(`not a prog_bin (magic "${magic}", expected "PROG")`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u8 = (o: number): number => view.getUint8(o)
  // 10-bit value: low byte + low 2 bits of the high byte.
  const u10 = (o: number): number => view.getUint16(o, true) & 0x03ff

  return {
    name: decodeName(bytes),
    octave: u8(16),
    portamento: u8(17),
    voiceModeDepth: u10(19),
    voiceModeType: u8(21),
    vco1Wave: u8(22),
    vco1Octave: u8(23),
    vco1Pitch: u10(24),
    vco1Shape: u10(26),
    vco2Wave: u8(28),
    vco2Octave: u8(29),
    vco2Pitch: u10(30),
    vco2Shape: u10(32),
    sync: u8(34),
    ring: u8(35),
    crossModDepth: u10(36),
    multiType: u8(38),
    selectNoise: u8(39),
    selectVPM: u8(40),
    selectUser: u8(41),
    shapeNoise: u10(42),
    shapeVPM: u10(44),
    shapeUser: u10(46),
    shiftShapeNoise: u10(48),
    shiftShapeVPM: u10(50),
    shiftShapeUser: u10(52),
    vco1Level: u10(54),
    vco2Level: u10(56),
    multiLevel: u10(58),
    cutoff: u10(60),
    resonance: u10(62),
    cutoffDrive: u8(64),
    cutoffKeyTrack: u8(65),
    ampAttack: u10(66),
    ampDecay: u10(68),
    ampSustain: u10(70),
    ampRelease: u10(72),
    egAttack: u10(74),
    egDecay: u10(76),
    egInt: u10(78),
    egTarget: u8(80),
    lfoWave: u8(81),
    lfoMode: u8(82),
    lfoRate: u10(83),
    lfoInt: u10(85),
    lfoTarget: u8(87),
    modFxOn: u8(88),
    modFxType: u8(89),
    modFxTime: u10(95),
    modFxDepth: u10(97),
    delayOn: u8(99),
    delayTime: u10(101),
    delayDepth: u10(103),
    reverbOn: u8(105),
    reverbTime: u10(107),
    reverbDepth: u10(109),
  }
}

/** Program name: 12 bytes at offset 4, ASCII, space/null-padded. */
function decodeName(bytes: Uint8Array): string {
  let name = ''
  for (let i = 4; i < 16; i++) {
    const b = bytes[i]
    if (b === 0) break
    name += String.fromCharCode(b)
  }
  return name.replace(/\s+$/, '')
}
