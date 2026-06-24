import { on } from '../events/bus'
import { createLivePatch } from '../services/live-patch'
import { connectMidi } from '../services/midi'

const MESSAGES: Record<string, string> = {
  unsupported:
    'Web MIDI isn’t supported here — open this page in Chrome or Edge.',
  requesting: 'Requesting MIDI access…',
  denied: 'MIDI access was denied. Reload the page and allow it.',
  'no-device':
    'No minilogue xd detected. Connect it over USB and switch it on.',
  connected: 'minilogue xd connected.',
  error: 'MIDI error.',
}

/** Wire the live-MIDI page: connect, mirror, and drive the status bar. */
export function initLive(): void {
  initStatusBar()

  const live = createLivePatch()
  void (async () => {
    const midi = await connectMidi({
      onDump: live.loadDump,
      onControlChange: live.controlChange,
    })
    const refreshBtn = document.getElementById('midi-refresh')
    if (!refreshBtn) return
    if (midi) refreshBtn.addEventListener('click', () => midi.refresh())
    else refreshBtn.setAttribute('hidden', '')
  })()
}

function initStatusBar(): void {
  const status = document.getElementById('midi-status')
  const text = status?.querySelector('.midi-text')
  const refreshBtn = document.getElementById('midi-refresh')
  const hint = document.getElementById('midi-hint')

  on('midi:status', ({ state, device, detail }) => {
    if (status) status.dataset.state = state
    if (text) {
      let msg = MESSAGES[state] ?? state
      if (state === 'connected' && device) msg = `${device} connected.`
      else if (state === 'error' && detail) msg = detail
      text.textContent = msg
    }
    const connected = state === 'connected'
    refreshBtn?.toggleAttribute('hidden', !connected)
    hint?.toggleAttribute('hidden', !connected)
  })
}
