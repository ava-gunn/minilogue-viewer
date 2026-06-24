import './styles/main.css'

// Web Awesome components — cherry-picked (we use inline SVG for waveform
// glyphs instead of <wa-icon>, so the icon component is intentionally absent).
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/details/details.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

// Custom synth controls (registers <xd-knob>, <xd-switch>, etc.).
import './components'

import { initApp } from './app'

initApp()
