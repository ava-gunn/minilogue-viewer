import { afterEach, describe, expect, it } from 'vitest'
import { clear, emit } from '../events/bus'
import './xd-led-group'
import './xd-switch'
import './xd-wave-selector'

afterEach(() => {
  document.body.innerHTML = ''
  clear()
})

function mount(tag: string, attrs: Record<string, string>): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.append(el)
  return el
}

describe('<xd-switch>', () => {
  it('moves the lever and marks the active tick', () => {
    const el = mount('xd-switch', {
      label: 'MODE',
      positions: 'BPM,NORMAL,1-SHOT',
      'data-section': 'lfo',
      'data-param-key': 'mode',
    })

    emit('param:change', { section: 'lfo', key: 'mode', value: 2 })

    expect(el.style.getPropertyValue('--active')).toBe('2')
    const ticks = el.shadowRoot?.querySelectorAll('.ticks span')
    expect(ticks?.[2]?.classList.contains('on')).toBe(true)
    expect(ticks?.[0]?.classList.contains('on')).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('MODE: 1-SHOT')
  })

  it('clamps an out-of-range index', () => {
    const el = mount('xd-switch', {
      positions: 'OFF,ON',
      'data-section': 'vco2',
      'data-param-key': 'sync',
    })

    emit('param:change', { section: 'vco2', key: 'sync', value: 9 })

    expect(el.style.getPropertyValue('--active')).toBe('1')
  })
})

describe('<xd-wave-selector>', () => {
  it('highlights the active waveform by value, regardless of display order', () => {
    const el = mount('xd-wave-selector', {
      'data-section': 'vco1',
      'data-param-key': 'wave',
    })

    emit('param:change', { section: 'vco1', key: 'wave', value: 2 })

    // SAW (value 2) is rendered first (top), so only that cell lights.
    const lit = el.shadowRoot?.querySelectorAll('.wave.on')
    expect(lit?.length).toBe(1)
    expect(lit?.[0]?.getAttribute('data-value')).toBe('2')
    expect(el.getAttribute('aria-label')).toBe('WAVE: SAW')
  })

  it('lights the SQR cell (bottom) for value 0', () => {
    const el = mount('xd-wave-selector', {
      'data-section': 'lfo',
      'data-param-key': 'wave',
    })

    emit('param:change', { section: 'lfo', key: 'wave', value: 0 })

    const lit = el.shadowRoot?.querySelector('.wave.on')
    expect(lit?.getAttribute('data-value')).toBe('0')
    expect(el.getAttribute('aria-label')).toBe('WAVE: SQR')
  })
})

describe('<xd-led-group>', () => {
  it('lights the program row, then a second row from a live value', () => {
    const el = mount('xd-led-group', {
      label: 'VOICE',
      labels: 'POLY,UNISON,CHORD,ARP',
      'data-section': 'voice',
      'data-param-key': 'mode',
    })

    emit('param:change', { section: 'voice', key: 'mode', value: 2 })

    const rows = el.shadowRoot?.querySelectorAll('.row')
    expect(rows?.[2]?.classList.contains('prog')).toBe(true)
    expect(rows?.[0]?.classList.contains('prog')).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('VOICE: CHORD')

    // A diverging live value lights a second (amber) row.
    emit('param:live', { section: 'voice', key: 'mode', value: 0 })
    expect(rows?.[0]?.classList.contains('live')).toBe(true)
    expect(el.getAttribute('aria-label')).toBe('VOICE: CHORD (synth POLY)')
  })
})
