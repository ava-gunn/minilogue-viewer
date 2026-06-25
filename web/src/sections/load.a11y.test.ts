import { beforeEach, expect, it, vi } from 'vitest'
import { emit, on } from '../events/bus'
import { initLibrary } from './load'

// The program library is an ARIA listbox; these guard its keyboard operability (the a11y
// pass replaced a click-only, keyboard-dead list with roving-tabindex + arrow/enter nav).

beforeEach(() => {
  document.body.innerHTML = `
    <div id="library-panel" hidden>
      <div id="program-list" role="listbox" aria-label="Program library"></div>
    </div>`
})

// biome-ignore lint/suspicious/noExplicitAny: minimal patch stubs for a DOM-behavior test
const patches = (n: number): any =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i}` }))

const options = (): HTMLElement[] =>
  Array.from(document.querySelectorAll('#program-list [role="option"]'))

const key = (el: HTMLElement, k: string): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}

it('builds keyboard-operable options with a roving tabindex', () => {
  initLibrary()
  emit('file:parsed-lib', { name: 'lib.mnlgxdlib', patches: patches(3) })
  const opts = options()
  expect(opts).toHaveLength(3)
  expect(opts.every((o) => o.getAttribute('role') === 'option')).toBe(true)
  expect(opts.map((o) => o.tabIndex)).toEqual([0, -1, -1]) // only the selected option is tabbable
  expect(opts[0].getAttribute('aria-selected')).toBe('true')
})

it('arrow keys move focus across options (wrapping)', () => {
  initLibrary()
  emit('file:parsed-lib', { name: 'lib', patches: patches(3) })
  const opts = options()
  opts[0].focus()
  key(opts[0], 'ArrowDown')
  expect(document.activeElement).toBe(opts[1])
  key(opts[1], 'ArrowUp')
  expect(document.activeElement).toBe(opts[0])
  key(opts[0], 'ArrowUp') // wraps to the last
  expect(document.activeElement).toBe(opts[2])
})

it('Enter selects an option: moves the tab stop + emits patch:load', () => {
  const onLoad = vi.fn()
  on('patch:load', onLoad)
  initLibrary()
  emit('file:parsed-lib', { name: 'lib', patches: patches(3) })
  const opts = options()
  key(opts[2], 'Enter')
  expect(opts[2].getAttribute('aria-selected')).toBe('true')
  expect(opts[2].tabIndex).toBe(0)
  expect(opts[0].tabIndex).toBe(-1)
  expect(onLoad).toHaveBeenCalledTimes(1)
})
