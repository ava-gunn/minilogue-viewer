import './styles/main.css'

// Web Awesome components — cherry-picked (we use inline SVG for waveform
// glyphs instead of <wa-icon>, so the icon component is intentionally absent).
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js'
import '@awesome.me/webawesome/dist/components/details/details.js'
import '@awesome.me/webawesome/dist/components/badge/badge.js'

// Custom synth controls (registers <xd-knob>, <xd-switch>, etc.).
import './components'

import { initViewer } from './app'
import { on } from './events/bus'
import { mountPanel } from './panel'
import { createSynthLink } from './services/synth-link'

mountPanel()
const link = createSynthLink()
initViewer(link)

// ---- Resynthesis: feature-flagged + lazy ---------------------------------------------------
// The whole re-synth bundle (ONNX inference, @google/genai, Turnstile, the form controller)
// loads only when the button is first clicked — and only when the flag is on. Set
// VITE_RESYNTH_ENABLED per environment (localhost .env / Vercel "Build" env vars).
const flag = String(import.meta.env.VITE_RESYNTH_ENABLED ?? '').toLowerCase()
const RESYNTH_ENABLED = flag === 'true' || flag === '1' || flag === 'on'

const openBtn = document.getElementById('resynth-open')
const form = document.getElementById('resynth-form')
const library = document.getElementById('library-panel')

if (!RESYNTH_ENABLED) {
  // Disabled: never wire the click, so the resynth chunk is never fetched.
  openBtn?.setAttribute('disabled', '')
  openBtn?.setAttribute('title', 'Resynthesis is currently unavailable')
} else {
  let inited = false

  // Below the synth, show the form OR the library — whichever the user opened last (the header
  // Resynthesis button shows the form; loading a .mnlgxdlib shows the library).
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

  // Deep link: the Ableton embed / a /resynth redirect lands on /?resynth=1 → open the form.
  if (new URLSearchParams(location.search).has('resynth')) openBtn?.click()
}
