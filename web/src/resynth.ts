import './styles/main.css'
import './styles/resynth.css'

// Web Awesome components used by the shared panel + status badge.
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

// Custom synth controls (registers <xd-knob>, <xd-switch>, etc.).
import './components'

import { mountPanel } from './panel'
import { initEffects } from './sections/effects'
import { initResynth } from './sections/resynth'
import { initShared } from './sections/shared'

// Same Korg panel as the viewer; the re-synth controller drives it via patch:load.
mountPanel()
initShared()
initEffects()
initResynth()
