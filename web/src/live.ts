import './styles/main.css'
import './styles/live.css'

// Web Awesome components used on this page (no library drawer, so no <wa-details>).
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

// Custom synth controls (registers <xd-knob>, <xd-switch>, etc.).
import './components'

import { mountPanel } from './panel'
import { initLive } from './sections/live'
import { initShared } from './sections/shared'

mountPanel()
initShared()
initLive()
