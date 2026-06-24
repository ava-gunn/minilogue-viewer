import { describe, expect, it } from 'vitest'
import { clamp01, knobAngle, splitLabels } from './util'

describe('clamp01', () => {
  it('clamps to the 0..1 range', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.42)).toBe(0.42)
    expect(clamp01(1)).toBe(1)
    expect(clamp01(2)).toBe(1)
  })
})

describe('knobAngle', () => {
  it('maps 0..1 across the 270° sweep', () => {
    expect(knobAngle(0)).toBe(-135)
    expect(knobAngle(0.5)).toBe(0)
    expect(knobAngle(1)).toBe(135)
  })

  it('clamps out-of-range input', () => {
    expect(knobAngle(-1)).toBe(-135)
    expect(knobAngle(5)).toBe(135)
  })
})

describe('splitLabels', () => {
  it('splits, trims and drops empties', () => {
    expect(splitLabels('SQR, TRI ,SAW')).toEqual(['SQR', 'TRI', 'SAW'])
    expect(splitLabels('')).toEqual([])
    expect(splitLabels(null)).toEqual([])
    expect(splitLabels('A,,B,')).toEqual(['A', 'B'])
  })
})
