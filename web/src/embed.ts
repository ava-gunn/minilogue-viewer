import './styles/main.css'
import './styles/embed.css'
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
import { initEmbed } from './services/host-bridge'
import { applyLocks, initLocks } from './services/locks'
import { createSynthLink } from './services/synth-link'

// Ableton embed: full web-app parity MINUS Resynthesis (ONNX stays in the browser — the "Web
// version" link opens it there). WKWebView has no Web MIDI, so the synth link reaches the
// minilogue xd through the local WebSocket bridge (see bridge/) when it's running.
mountPanel()
const link = createSynthLink()
initViewer(link) // panel + library (ratings/filter/export) + effects + MIDI status + Refresh

const panelRoot = document.getElementById('panel-root')
if (panelRoot) initLocks(panelRoot)

// Randomize (shown once the synth is connected): a locked-aware patch, shown in the panel and
// loaded to the hardware over the bridge.
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

initEmbed()
