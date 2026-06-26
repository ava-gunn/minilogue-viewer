import { on } from '../events/bus'

const MIDI_MESSAGES: Record<string, string> = {
  unsupported: 'Web MIDI isn’t supported in this browser.',
  requesting: 'Connecting to MIDI…',
  denied: 'MIDI access was denied. Reload the page and allow it.',
  'no-device':
    'No minilogue xd detected — connect it over USB to mirror it live.',
  connected: 'minilogue xd connected.',
  error: 'MIDI error.',
}

// Call before connecting MIDI so it catches the first status event.
export function initMidiStatus(): void {
  const status = document.getElementById('midi-status')
  const text = status?.querySelector('.midi-text')
  const btn = document.getElementById('midi-refresh')

  on('midi:status', ({ state, device, detail }) => {
    if (status) status.dataset.state = state
    if (text) {
      let msg = MIDI_MESSAGES[state] ?? state
      if (state === 'connected' && device) msg = `${device} connected`
      else if (state === 'error' && detail) msg = detail
      text.textContent = msg
    }
    btn?.toggleAttribute('hidden', state !== 'connected')
  })
}
