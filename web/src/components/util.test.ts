import { describe, expect, it } from 'vitest'
import { emit } from '../events/bus'
import { clamp01, knobAngle, onParam, splitLabels } from './util'

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

describe('onParam', () => {
  const el = (): HTMLElement => {
    const e = document.createElement('div')
    e.dataset.section = 'filter'
    e.dataset.paramKey = 'cutoff'
    return e
  }

  it('delivers matching param:change / param:live to its control', () => {
    const seen: number[] = []
    const off = onParam('param:live', el(), (v) => seen.push(v))
    emit('param:live', { section: 'filter', key: 'cutoff', value: 0.5 })
    emit('param:live', { section: 'lfo', key: 'rate', value: 0.9 }) // wrong control
    expect(seen).toEqual([0.5])
    off()
  })

  it('a locked control ignores live knob turns but still takes program values', () => {
    const target = el()
    target.classList.add('locked')
    const live: number[] = []
    const prog: number[] = []
    const offLive = onParam('param:live', target, (v) => live.push(v))
    const offProg = onParam('param:change', target, (v) => prog.push(v))
    emit('param:live', { section: 'filter', key: 'cutoff', value: 0.7 })
    emit('param:change', { section: 'filter', key: 'cutoff', value: 0.3 })
    expect(live).toEqual([]) // frozen
    expect(prog).toEqual([0.3]) // program layer still updates
    offLive()
    offProg()
  })
})
