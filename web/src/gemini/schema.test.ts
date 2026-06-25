import { describe, expect, it } from 'vitest'
import { PARAM_SPEC } from '../parser/param-spec'
import {
  ANALYSIS_FIELDS,
  buildAnalysisSchema,
  buildProgramSchema,
  continuousToRaw,
  ENVELOPE_FIELDS,
  PARAM_GLOSSARY,
  programToRawById,
} from './schema'

describe('buildProgramSchema', () => {
  const schema = buildProgramSchema()
  const program = schema.properties?.program

  it('has one program property per param, in spec order, all required', () => {
    const ids = PARAM_SPEC.map((p) => p.id)
    expect(Object.keys(program?.properties ?? {})).toEqual(ids)
    expect(program?.propertyOrdering).toEqual(ids)
    expect(program?.required).toEqual(ids)
  })

  it('types each param: continuous=NUMBER, discrete=STRING enum / INTEGER, boolean=BOOLEAN', () => {
    const props = program?.properties ?? {}
    expect(props.cutoff?.type).toBe('NUMBER')
    expect(props.sync?.type).toBe('BOOLEAN')
    expect(props.vco1_wave?.type).toBe('STRING')
    expect(props.vco1_wave?.enum).toEqual(['SQR', 'TRI', 'SAW'])
    // octave has a cardinality but no value labels -> INTEGER
    expect(props.octave?.type).toBe('INTEGER')
  })
})

describe('buildAnalysisSchema', () => {
  it('has the string analysis fields plus a numeric envelope object, all required', () => {
    const schema = buildAnalysisSchema()
    const keys = [...Object.keys(ANALYSIS_FIELDS), 'envelope']
    expect(schema.type).toBe('OBJECT')
    expect(Object.keys(schema.properties ?? {})).toEqual(keys)
    expect(schema.required).toEqual(keys)
    expect(schema.properties?.sound_type?.type).toBe('STRING')

    const env = schema.properties?.envelope
    expect(env?.type).toBe('OBJECT')
    expect(Object.keys(env?.properties ?? {})).toEqual(
      Object.keys(ENVELOPE_FIELDS),
    )
    expect(env?.required).toEqual(Object.keys(ENVELOPE_FIELDS))
    expect(env?.properties?.sustain?.type).toBe('NUMBER')
  })
})

describe('continuousToRaw', () => {
  it('maps 0..1 to the param raw range, clamping out-of-range', () => {
    expect(continuousToRaw('amp_sustain', 0)).toBe(0)
    expect(continuousToRaw('amp_sustain', 1)).toBe(1023)
    expect(continuousToRaw('amp_sustain', 2)).toBe(1023)
    expect(continuousToRaw('portamento', 1)).toBe(127) // 8-bit param
  })

  it('returns 0 for unknown or non-continuous params', () => {
    expect(continuousToRaw('vco1_wave', 1)).toBe(0) // discrete
    expect(continuousToRaw('nope', 1)).toBe(0)
  })
})

describe('PARAM_GLOSSARY', () => {
  it('describes every param', () => {
    for (const p of PARAM_SPEC) expect(PARAM_GLOSSARY[p.id]).toBeTruthy()
  })
})

describe('programToRawById', () => {
  it('maps continuous 0..1 to raw, clamping', () => {
    expect(programToRawById({ cutoff: 1 }).cutoff).toBe(1023)
    expect(programToRawById({ cutoff: 0.5 }).cutoff).toBe(512)
    expect(programToRawById({ cutoff: 2 }).cutoff).toBe(1023)
    expect(programToRawById({ portamento: 1 }).portamento).toBe(127) // 8-bit param
  })

  it('maps discrete labels to indices and clamps integers', () => {
    expect(programToRawById({ vco1_wave: 'SAW' }).vco1_wave).toBe(2)
    expect(programToRawById({ vco1_wave: 'SQR' }).vco1_wave).toBe(0)
    // unknown label / integer fallback, clamped to cardinality - 1
    expect(programToRawById({ octave: 9 }).octave).toBe(4)
  })

  it('maps booleans and defaults missing params to 0', () => {
    expect(programToRawById({ sync: true }).sync).toBe(1)
    expect(programToRawById({ sync: false }).sync).toBe(0)
    expect(programToRawById({}).cutoff).toBe(0)
  })

  it('produces a value for every param id', () => {
    const raw = programToRawById({})
    for (const p of PARAM_SPEC) expect(raw[p.id]).toBeDefined()
  })
})
