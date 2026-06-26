import './styles/main.css'
import './styles/random-patch.css'

import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/details/details.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

import './components'

import { initViewer } from './app'
import { emit, on } from './events/bus'
import { rawByIdToPatch } from './inference/decode'
import { mountPanel } from './panel'
import { randomSweepRawById } from './parser/random-patch'
import { writeProgBin } from './parser/write'
import { createSynthLink } from './services/synth-link'

mountPanel()
const link = createSynthLink()
initViewer(link)

const randomBtn = document.getElementById('random-patch')
on('midi:status', ({ state }) => {
  randomBtn?.toggleAttribute('hidden', state !== 'connected')
})
randomBtn?.addEventListener('click', () => {
  const raw = randomSweepRawById()
  emit('patch:load', {
    patch: rawByIdToPatch(raw, 'RANDOM'),
    index: 0,
    total: 1,
  })
  const template = link.getTemplate()
  if (template) link.sendProgram(writeProgBin(template, raw))
})

// Gated by the VITE_RESYNTH_ENABLED env var; the resynth bundle is lazy-imported on first click.
const flag = String(import.meta.env.VITE_RESYNTH_ENABLED ?? '').toLowerCase()
const RESYNTH_ENABLED = flag === 'true' || flag === '1' || flag === 'on'

const openBtn = document.getElementById('resynth-open')
const form = document.getElementById('resynth-form')
const library = document.getElementById('library-panel')

if (!RESYNTH_ENABLED) {
  openBtn?.setAttribute('disabled', '')
  openBtn?.setAttribute('title', 'Resynthesis is currently unavailable')
} else {
  let inited = false

  const show = (what: 'form' | 'library'): void => {
    form?.toggleAttribute('hidden', what !== 'form')
    library?.toggleAttribute('hidden', what !== 'library')
  }

  on('file:parsed-lib', () => show('library'))

  openBtn?.addEventListener('click', async () => {
    if (!inited) {
      const { initResynth } = await import('./sections/resynth')
      initResynth(link)
      inited = true
    }
    show('form')
  })

  // Deep link: /?resynth=1 (Ableton embed / /resynth redirect) opens the form.
  if (new URLSearchParams(location.search).has('resynth')) openBtn?.click()
}
