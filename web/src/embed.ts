import './styles/main.css'
import './styles/embed.css'

import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/details/details.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

import './components'

import { mountPanel } from './panel'
import { initEffects } from './sections/effects'
import { initLibrary, initLoad } from './sections/load'
import { initShared } from './sections/shared'
import { initEmbed } from './services/host-bridge'

// Ableton embed: no Web MIDI / ONNX in the WebView; Resynthesis opens the deployed app via the host bridge.
mountPanel()
initShared()
initEffects()
initLoad()
initLibrary()
initEmbed()

// Live's WebView can't open an OS file picker from a click, so the OLED hint is drop-only.
const oledHint = document
  .getElementById('oled')
  ?.shadowRoot?.querySelector('.hint')
if (oledHint) oledHint.textContent = 'drop a patch file here'
