import { describe, expect, it } from 'vitest'
import { PARAM_SPEC } from '../parser/param-spec'
import {
  ANALYSIS_FIELDS,
  buildAnalysisSchema,
  buildProgramSchema,
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
  it('is a flat object with one required string field per analysis trait', () => {
    const schema = buildAnalysisSchema()
    expect(schema.type).toBe('OBJECT')
    expect(Object.keys(schema.properties ?? {})).toEqual(
      Object.keys(ANALYSIS_FIELDS),
    )
    expect(schema.propertyOrdering).toEqual(Object.keys(ANALYSIS_FIELDS))
    expect(schema.required).toEqual(Object.keys(ANALYSIS_FIELDS))
    expect(schema.properties?.sound_type?.type).toBe('STRING')
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
