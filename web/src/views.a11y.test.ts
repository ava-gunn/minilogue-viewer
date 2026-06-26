import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const view = (name: string): Document => {
  // vitest runs with cwd = web/, where the view HTML files live.
  const html = readFileSync(resolve(process.cwd(), name), 'utf8')
  return new DOMParser().parseFromString(html, 'text/html')
}

const ALL = ['index.html', 'embed.html']

describe.each(ALL)('%s — page structure', (name) => {
  const doc = view(name)

  it('declares the document language', () => {
    expect(doc.documentElement.getAttribute('lang')).toBe('en')
  })

  it('has exactly one <main> landmark with a matching skip link', () => {
    expect(doc.querySelectorAll('main')).toHaveLength(1)
    const skip = doc.querySelector('a.skip-link')
    expect(skip).not.toBeNull()
    expect(skip?.getAttribute('href')).toBe('#main')
    expect(doc.querySelector('#main')).not.toBeNull()
  })

  it('has exactly one non-empty <h1>', () => {
    const h1s = doc.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
    expect(h1s[0].textContent?.trim()).toBeTruthy()
  })
})

describe.each([
  'index.html',
  'embed.html',
])('%s — program library is an accessible listbox', (name) => {
  const list = view(name).querySelector('#program-list')

  it('has role=listbox and an accessible name', () => {
    expect(list?.getAttribute('role')).toBe('listbox')
    expect(list?.getAttribute('aria-label')).toBeTruthy()
  })
})

describe('index.html — MIDI status is announced', () => {
  it('marks #midi-status as a live status region', () => {
    expect(
      view('index.html').querySelector('#midi-status')?.getAttribute('role'),
    ).toBe('status')
  })
})

describe('index.html — resynth form', () => {
  const doc = view('index.html')

  it('the waveform canvas has an image role + label', () => {
    const c = doc.querySelector('#resynth-wave')
    expect(c?.getAttribute('role')).toBe('img')
    expect(c?.getAttribute('aria-label')).toBeTruthy()
  })

  it('the generated-patch result is a live region', () => {
    expect(
      doc.querySelector('#resynth-result')?.getAttribute('aria-live'),
    ).toBe('polite')
  })

  it('the Gemini key is described by its note', () => {
    const id = doc
      .querySelector('#gemini-key')
      ?.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    expect(doc.getElementById(id as string)).not.toBeNull()
  })

  it('every visible form control has an accessible name', () => {
    for (const el of doc.querySelectorAll<HTMLElement>('input, select')) {
      if (el.hasAttribute('hidden')) continue // e.g. the file input, operated via its button
      const id = el.getAttribute('id')
      const named =
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        el.closest('label') ||
        (id && doc.querySelector(`label[for="${id}"]`))
      expect(
        named,
        `${el.tagName.toLowerCase()}#${id ?? '?'} has no accessible name`,
      ).toBeTruthy()
    }
  })
})
