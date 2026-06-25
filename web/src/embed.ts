import './styles/main.css'
import './styles/embed.css'

// Web Awesome components used by the shared panel + status badge + library drawer.
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/details/details.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

import './components'

import { emit, on } from './events/bus'
import { mountPanel } from './panel'
import { initEffects } from './sections/effects'
import { initLibrary, initLoad } from './sections/load'
import { initShared } from './sections/shared'
import { initEmbedLink } from './services/host-bridge'

// Viewer-only build for the Ableton extension: the shared Korg panel + patch-file loading,
// with NO inference (ONNX) and NO Web MIDI (unavailable in the embedded WebView). The
// Resynthesis link opens the deployed app in the system browser via the host bridge.
mountPanel()
initShared()
initEffects()
initLoad()
initLibrary()
initEmbedLink()

// Audio matching / re-synthesis is browser-only; guide the user there if they pick audio.
on('audio:dropped', () =>
  emit('file:error', {
    message: 'Audio re-synthesis is available in the browser — use Resynthesis.',
  }),
)
