import { afterEach, describe, expect, it } from 'vitest'
import { clear, emit } from '../events/bus'
import './xd-lcd'

afterEach(() => {
  document.body.innerHTML = ''
  clear()
})

function mount(): HTMLElement {
  const el = document.createElement('xd-lcd')
  el.dataset.section = 'multi'
  el.dataset.paramKey = 'typeValue'
  el.setAttribute('placeholder', '----')
  document.body.append(el)
  return el
}

const text = (el: HTMLElement) =>
  el.shadowRoot?.querySelector('.lcd')?.textContent

describe('<xd-lcd>', () => {
  it('shows the display text from a matching param:change', () => {
    const el = mount()
    emit('param:change', {
      section: 'multi',
      key: 'typeValue',
      value: 0,
      display: 'HIGH',
    })
    expect(text(el)).toBe('HIGH')
    expect(el.getAttribute('aria-label')).toBe('HIGH')
  })

  it('ignores unrelated params and keeps the placeholder', () => {
    const el = mount()
    emit('param:change', { section: 'lfo', key: 'rate', value: 0.5 })
    expect(text(el)).toBe('----')
  })
})
