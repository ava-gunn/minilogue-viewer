import { describe, expect, it } from 'vitest'
import { egIntToPercent, norm7, norm10, pitchToCents } from './transforms'

describe('norm10 / norm7', () => {
  it('normalizes to 0..1', () => {
    expect(norm10(0)).toBe(0)
    expect(norm10(1023)).toBe(1)
    expect(norm10(512)).toBeCloseTo(0.5, 2)
    expect(norm7(0)).toBe(0)
    expect(norm7(127)).toBe(1)
  })
})

describe('pitchToCents (hardware-calibrated)', () => {
  it('floors and ceils at ±1200', () => {
    expect(pitchToCents(0)).toBe(-1200)
    expect(pitchToCents(1023)).toBe(1200)
  })

  it('is ~0 at the center', () => {
    expect(pitchToCents(512)).toBe(0)
    expect(pitchToCents(515)).toBe(0)
  })

  it('matches measured hardware breakpoints', () => {
    expect(pitchToCents(547)).toBe(7)
    expect(pitchToCents(660)).toBe(93)
    expect(pitchToCents(861)).toBe(710) // "Sharp Fifth"
    expect(pitchToCents(958)).toBe(1004)
  })

  it('interpolates between breakpoints', () => {
    expect(pitchToCents(900)).toBe(828)
  })

  it('is symmetric about the center', () => {
    expect(pitchToCents(163)).toBe(-710)
  })
})

describe('egIntToPercent', () => {
  it('spans -100..+100 with a centered zero', () => {
    expect(egIntToPercent(0)).toBe(-100)
    expect(egIntToPercent(11)).toBe(-100)
    expect(egIntToPercent(512)).toBe(0)
    expect(egIntToPercent(1023)).toBe(100)
  })
})
