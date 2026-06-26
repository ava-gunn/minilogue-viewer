import { afterEach, describe, expect, it } from 'vitest'
import { clear, emit } from '../events/bus'
import type { MinilogueXDPatch } from '../types/synth'
import './xd-display'

afterEach(() => {
  document.body.innerHTML = ''
  clear()
})

const patch = (name: string) => ({ name }) as unknown as MinilogueXDPatch

describe('<xd-display>', () => {
  it('shows the program name on patch:load', () => {
    const el = document.createElement('xd-display')
    document.body.append(el)

    emit('patch:load', { patch: patch('BRASS STAB'), index: 0, total: 1 })

    expect(el.shadowRoot?.querySelector('.name')?.textContent).toBe(
      'BRASS STAB',
    )
    expect(el.shadowRoot?.querySelector('.index')?.textContent).toBe('')
  })

  it('shows a 1-based index for libraries', () => {
    const el = document.createElement('xd-display')
    document.body.append(el)

    emit('patch:load', { patch: patch('PAD'), index: 11, total: 500 })

    expect(el.shadowRoot?.querySelector('.index')?.textContent).toBe('12 / 500')
  })
})
