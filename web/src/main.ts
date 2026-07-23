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
import { applyLocks, initLocks } from './services/locks'
import { createSynthLink } from './services/synth-link'

mountPanel()
const link = createSynthLink()
initViewer(link)

const panelRoot = document.getElementById('panel-root')
if (panelRoot) initLocks(panelRoot)

const randomBtn = document.getElementById('random-patch')
on('midi:status', ({ state }) => {
  randomBtn?.toggleAttribute('hidden', state !== 'connected')
})
randomBtn?.addEventListener('click', () => {
  const raw = applyLocks(randomSweepRawById())
  emit('patch:load', {
    patch: rawByIdToPatch(raw, 'RANDOM'),
    rawById: raw,
    index: 0,
    total: 1,
  })
  const template = link.getTemplate()
  if (template) link.sendProgram(writeProgBin(template, raw))
})

// Resynthesis is disabled globally — no entry point. The program library still opens on load.
const library = document.getElementById('library-panel')
on('file:parsed-lib', () => library?.removeAttribute('hidden'))
