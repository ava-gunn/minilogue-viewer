import { beforeEach, expect, it, vi } from 'vitest'
import { clear, emit, on } from '../events/bus'
import { initLibrary } from './load'

beforeEach(() => {
  clear()
  localStorage.clear()
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

const starsOf = (i: number): NodeListOf<HTMLButtonElement> =>
  options()[i].querySelectorAll<HTMLButtonElement>('.xd-star')

const onCount = (i: number): number =>
  options()[i].querySelectorAll('.xd-star.on').length

const setFilter = (value: string): void => {
  const sel = document.getElementById(
    'library-filter-select',
  ) as HTMLSelectElement
  sel.value = value
  sel.dispatchEvent(new Event('change'))
}

it('renders a 5-button star widget per option', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'lib',
    patches: patches(2),
    keys: ['a1', 'a2'],
  })
  expect(options()).toHaveLength(2)
  for (const opt of options()) {
    expect(opt.querySelectorAll('.xd-star')).toHaveLength(5)
  }
})

it('clicking a star sets and persists the rating', () => {
  initLibrary()
  emit('file:parsed-lib', { name: 'lib', patches: patches(1), keys: ['b1'] })
  starsOf(0)[2].click() // 3rd star -> rating 3
  expect(onCount(0)).toBe(3)
  const stored = JSON.parse(localStorage.getItem('xd-patch-ratings-v1') ?? '{}')
  expect(stored.b1).toBe(3)
})

it('re-clicking the current top star clears the rating', () => {
  initLibrary()
  emit('file:parsed-lib', { name: 'lib', patches: patches(1), keys: ['c1'] })
  starsOf(0)[3].click() // rating 4
  expect(onCount(0)).toBe(4)
  starsOf(0)[3].click() // clear
  expect(onCount(0)).toBe(0)
})

it('number keys rate the focused option', () => {
  initLibrary()
  emit('file:parsed-lib', { name: 'lib', patches: patches(1), keys: ['d1'] })
  options()[0].dispatchEvent(
    new KeyboardEvent('keydown', { key: '5', bubbles: true }),
  )
  expect(onCount(0)).toBe(5)
})

it('a star click does not select the option', () => {
  const onLoad = vi.fn()
  on('patch:load', onLoad)
  initLibrary()
  emit('file:parsed-lib', {
    name: 'lib',
    patches: patches(2),
    keys: ['e1', 'e2'],
  })
  starsOf(1)[0].click()
  expect(onLoad).not.toHaveBeenCalled()
})

it('filters options by minimum stars', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'lib',
    patches: patches(3),
    keys: ['f1', 'f2', 'f3'],
  })
  starsOf(0)[4].click() // f1 = 5
  starsOf(1)[1].click() // f2 = 2  (f3 unrated)
  setFilter('3')
  expect(options()[0].hidden).toBe(false) // 5 >= 3
  expect(options()[1].hidden).toBe(true) // 2 < 3
  expect(options()[2].hidden).toBe(true) // 0 < 3
})

it('filters to unrated patches', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'lib',
    patches: patches(2),
    keys: ['g1', 'g2'],
  })
  starsOf(0)[0].click() // g1 = 1  (g2 unrated)
  setFilter('unrated')
  expect(options()[0].hidden).toBe(true)
  expect(options()[1].hidden).toBe(false)
})
