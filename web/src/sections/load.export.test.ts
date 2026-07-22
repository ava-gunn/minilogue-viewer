import { beforeEach, expect, it, vi } from 'vitest'
import { clear, emit } from '../events/bus'
import { initLibrary } from './load'

beforeEach(() => {
  clear()
  localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  // Stub only the download <a>'s click, so real button dispatches (stars, export) still fire.
  HTMLAnchorElement.prototype.click = () => {}
  document.body.innerHTML = `
    <div id="library-panel" hidden>
      <div id="program-list" role="listbox" aria-label="Program library"></div>
    </div>`
})

// biome-ignore lint/suspicious/noExplicitAny: minimal patch stubs for a DOM-behavior test
const patches = (n: number): any =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i}` }))
const bins = (n: number): Uint8Array[] =>
  Array.from({ length: n }, () => new Uint8Array(1024))
const options = (): HTMLElement[] =>
  Array.from(document.querySelectorAll('#program-list [role="option"]'))
const exportBtn = (): HTMLButtonElement =>
  document.getElementById('library-export') as HTMLButtonElement
const starsOf = (i: number): NodeListOf<HTMLButtonElement> =>
  options()[i].querySelectorAll<HTMLButtonElement>('.xd-star')
const setFilter = (v: string): void => {
  const sel = document.getElementById(
    'library-filter-select',
  ) as HTMLSelectElement
  sel.value = v
  sel.dispatchEvent(new Event('change'))
}

it('shows an enabled Export button when patches are visible', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'l.mnlgxdlib',
    patches: patches(3),
    keys: ['a0', 'a1', 'a2'],
    bins: bins(3),
  })
  expect(exportBtn()).toBeTruthy()
  expect(exportBtn().disabled).toBe(false)
})

it('disables Export when the filter hides everything', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'l',
    patches: patches(2),
    keys: ['b0', 'b1'],
    bins: bins(2),
  })
  setFilter('5') // nothing is rated 5
  expect(exportBtn().disabled).toBe(true)
})

it('clicking Export downloads a library of the filtered patches', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'l',
    patches: patches(3),
    keys: ['c0', 'c1', 'c2'],
    bins: bins(3),
  })
  starsOf(0)[4].click() // c0 = 5 stars
  setFilter('5')
  expect(options().filter((o) => !o.hidden)).toHaveLength(1)
  exportBtn().click()
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
})

it('does not offer export at all without bins in the payload', () => {
  initLibrary()
  emit('file:parsed-lib', {
    name: 'l',
    patches: patches(2),
    keys: ['d0', 'd1'],
  })
  expect(exportBtn().disabled).toBe(true)
})
