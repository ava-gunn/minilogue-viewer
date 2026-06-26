import { afterEach, describe, expect, it } from 'vitest'
import { clear, emit } from '../events/bus'
import './xd-knob'

afterEach(() => {
  document.body.innerHTML = ''
  clear()
})

function mountKnob(attrs: Record<string, string>): HTMLElement {
  const el = document.createElement('xd-knob')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.append(el)
  return el
}

describe('<xd-knob>', () => {
  it('rotates the indicator on a matching param:change', () => {
    const el = mountKnob({
      label: 'CUTOFF',
      'data-section': 'filter',
      'data-param-key': 'cutoff',
    })

    emit('param:change', { section: 'filter', key: 'cutoff', value: 0.5 })

    expect(el.style.getPropertyValue('--knob-angle')).toBe('0deg')
    expect(el.getAttribute('aria-label')).toBe('CUTOFF: 50%')
  })

  it('ignores param:change for other sections/keys', () => {
    const el = mountKnob({
      'data-section': 'filter',
      'data-param-key': 'cutoff',
    })
    const before = el.style.getPropertyValue('--knob-angle')

    emit('param:change', { section: 'lfo', key: 'rate', value: 1 })

    expect(el.style.getPropertyValue('--knob-angle')).toBe(before)
  })

  it('uses a supplied display string in the readout', () => {
    const el = mountKnob({
      label: 'PITCH',
      'data-section': 'vco1',
      'data-param-key': 'pitchCents',
    })

    emit('param:change', {
      section: 'vco1',
      key: 'pitchCents',
      value: 0.75,
      display: '+12¢',
    })

    expect(el.getAttribute('aria-label')).toBe('PITCH: +12¢')
  })

  it('does not subscribe when decorative', () => {
    const el = mountKnob({
      decorative: '',
      'data-section': 'global',
      'data-param-key': 'master',
    })
    const before = el.style.getPropertyValue('--knob-angle')

    emit('param:change', { section: 'global', key: 'master', value: 1 })

    expect(el.style.getPropertyValue('--knob-angle')).toBe(before)
  })

  it('unsubscribes on disconnect', () => {
    const el = mountKnob({
      'data-section': 'filter',
      'data-param-key': 'cutoff',
    })
    el.remove()

    emit('param:change', { section: 'filter', key: 'cutoff', value: 1 })

    expect(el.style.getPropertyValue('--knob-angle')).toBe('-135deg')
  })
})
