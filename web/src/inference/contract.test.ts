import { describe, expect, it } from 'vitest'
import { PARAM_SPEC } from '../parser/param-spec'
import {
  booleanParams,
  continuousParams,
  discreteParams,
  N_FRAMES,
  TOTAL_DISCRETE,
} from './contract'

describe('inference contract', () => {
  it('partitions every param into one of the three head types', () => {
    const total =
      continuousParams.length + discreteParams.length + booleanParams.length
    expect(total).toBe(PARAM_SPEC.length)
    expect(continuousParams).toHaveLength(31)
    expect(discreteParams).toHaveLength(16)
    expect(booleanParams).toHaveLength(5)
  })

  it('agrees with the exported model head sizes', () => {
    expect(TOTAL_DISCRETE).toBe(81)
    expect(N_FRAMES).toBe(83)
  })
})
