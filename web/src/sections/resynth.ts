// The built-in ONNX model matches audio to a rawById map; see inference/index + inference/decode.

// CSS rides along in this lazily-loaded chunk so the viewer's initial bundle stays free of the form styles.
import '../styles/resynth.css'

import { emit, on } from '../events/bus'
import { AUDIO_ACCEPT } from '../events/files'
import { matchAudioRawById } from '../inference'
import { rawByIdToPatch } from '../inference/decode'
import { readRawById, writeProgBin } from '../parser/write'
import { type Rating, submitContribution } from '../services/contribute'
import type { SynthLink } from '../services/synth-link'
import { toast } from '../services/toast'
import {
  mountTurnstile,
  resetTurnstile,
  turnstileEnabled,
  turnstileToken,
} from '../services/turnstile'

const STEPS = ['upload', 'patch', 'try', 'feedback'] as const
type Step = (typeof STEPS)[number]

// Label stored with each contribution to record which matcher produced it.
const BUILTIN_MODEL = 'builtin-onnx'

const byId = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

const isAudio = (name: string): boolean =>
  AUDIO_ACCEPT.split(',').some((ext) => name.toLowerCase().endsWith(ext.trim()))

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

let file: File | undefined
let rawById: Record<string, number> | undefined
let patchName: string | undefined
let objectUrl: string | undefined

export function initResynth(link: SynthLink): void {
  const stepEls = Array.from(
    document.querySelectorAll<HTMLLIElement>('#resynth-steps li'),
  )
  if (stepEls.length === 0) return // not on this page

  const drop = byId('resynth-drop')
  const fileBtn = byId<HTMLButtonElement>('resynth-file-btn')
  const fileInput = byId<HTMLInputElement>('resynth-file')
  const filename = byId('resynth-filename')
  const clearBtn = byId<HTMLButtonElement>('resynth-clear')

  const preview = byId('resynth-preview')
  const canvas = byId<HTMLCanvasElement>('resynth-wave')
  const playBtn = byId<HTMLButtonElement>('resynth-play')
  const progress = byId('resynth-progress')
  const timeEl = byId('resynth-time')
  const audio = byId<HTMLAudioElement>('resynth-audio')

  const generateBtn = byId<HTMLButtonElement>('resynth-generate')
  const loadBtn = byId<HTMLButtonElement>('resynth-load')
  const spinner = byId('resynth-spinner')
  const status = byId('resynth-status')

  const feedback = byId('resynth-feedback')
  const result = byId('resynth-result')
  const pitchSel = byId<HTMLSelectElement>('resynth-pitch')
  const asIsBtn = byId<HTMLButtonElement>('resynth-asis')
  const mineBtn = byId<HTMLButtonElement>('resynth-mine')
  const turnstileBox = byId('resynth-turnstile')

  const setStatus = (msg: string): void => {
    if (status) status.textContent = msg
  }
  const setStep = (name: Step): void => {
    const idx = STEPS.indexOf(name)
    for (const li of stepEls) {
      const i = STEPS.indexOf((li.dataset.step ?? '') as Step)
      li.classList.toggle('done', i < idx)
      li.classList.toggle('active', i === idx)
      if (i === idx) li.setAttribute('aria-current', 'step')
      else li.removeAttribute('aria-current')
    }
  }
  let connected = false
  const updateLoad = (): void => {
    // Read live state (a captured template implies a connected+dumped synth) rather than the
    // `connected` event — initResynth is lazy and can miss it if MIDI connected before opening.
    const ready = !!(link.getTemplate() && rawById)
    loadBtn?.toggleAttribute('hidden', !ready)
    if (loadBtn) loadBtn.disabled = !ready
  }

  // Gates Generate until drawWaveform has finished so the audio is decoded before we match.
  let waveformReady = false

  const updateGenerate = (): void => {
    if (generateBtn) generateBtn.disabled = !(file && waveformReady)
  }

  async function drawWaveform(f: File): Promise<void> {
    if (!canvas) return
    canvas.setAttribute('aria-label', `Waveform of ${f.name}`)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height } = canvas
    ctx.clearRect(0, 0, width, height)
    const mid = height / 2
    let data: Float32Array | undefined
    let ac: AudioContext | undefined
    try {
      ac = new AudioContext()
      const buf = await ac.decodeAudioData(await f.arrayBuffer())
      data = buf.getChannelData(0)
    } catch {
      // Undecodable — show a flat baseline.
    } finally {
      void ac?.close() // close on every path so bad files don't exhaust AudioContexts
    }
    ctx.fillStyle =
      getComputedStyle(canvas).getPropertyValue('color').trim() || '#2dd4bf'
    if (!data) {
      ctx.fillRect(0, mid, width, 1)
      return
    }
    const step = Math.max(1, Math.floor(data.length / width))
    for (let x = 0; x < width; x++) {
      let min = 1
      let max = -1
      for (let j = 0; j < step; j++) {
        const v = data[x * step + j] ?? 0
        if (v < min) min = v
        if (v > max) max = v
      }
      ctx.fillRect(x, mid + min * mid, 1, Math.max(1, (max - min) * mid))
    }
  }

  const loadPreview = (f: File): void => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(f)
    if (audio) audio.src = objectUrl
    if (playBtn) playBtn.textContent = '▶'
    if (progress) progress.style.width = '0%'
    preview?.removeAttribute('hidden')
    void drawWaveform(f).finally(() => {
      // Enable even on decode failure — the raw audio still feeds the matcher.
      waveformReady = true
      updateGenerate()
    })
  }

  playBtn?.addEventListener('click', () => {
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  })
  audio?.addEventListener('play', () => {
    if (playBtn) {
      playBtn.textContent = '⏸'
      playBtn.setAttribute('aria-label', 'Pause')
    }
  })
  const onStop = (): void => {
    if (playBtn) {
      playBtn.textContent = '▶'
      playBtn.setAttribute('aria-label', 'Play')
    }
  }
  audio?.addEventListener('pause', onStop)
  audio?.addEventListener('ended', onStop)
  audio?.addEventListener('timeupdate', () => {
    if (!audio) return
    if (timeEl) timeEl.textContent = fmtTime(audio.currentTime)
    if (progress && audio.duration) {
      progress.style.width = `${(audio.currentTime / audio.duration) * 100}%`
    }
  })

  const clearAudio = (): void => {
    file = undefined
    rawById = undefined
    waveformReady = false
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = undefined
    }
    audio?.removeAttribute('src')
    if (filename) filename.textContent = ''
    preview?.setAttribute('hidden', '')
    drop?.removeAttribute('hidden')
    feedback?.setAttribute('hidden', '')
    setStep('upload')
    setStatus('')
    updateGenerate()
  }

  const acceptAudio = (f: File): void => {
    if (!isAudio(f.name)) {
      setStatus(`Unsupported file: ${f.name}`)
      return
    }
    file = f
    rawById = undefined
    waveformReady = false
    if (filename) filename.textContent = f.name
    feedback?.setAttribute('hidden', '')
    drop?.setAttribute('hidden', '')
    updateGenerate()
    loadPreview(f)
    setStatus('')
    setStep('patch')
  }

  fileBtn?.addEventListener('click', () => fileInput?.click())
  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0]
    if (f) acceptAudio(f)
    fileInput.value = ''
  })
  drop?.addEventListener('dragover', (e) => {
    e.preventDefault()
    drop.classList.add('dragover')
  })
  drop?.addEventListener('dragleave', () => drop.classList.remove('dragover'))
  drop?.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('dragover')
    const f = e.dataTransfer?.files?.[0]
    if (f) acceptAudio(f)
  })
  clearBtn?.addEventListener('click', clearAudio)

  generateBtn?.addEventListener('click', async () => {
    const f = file
    if (!f) return
    if (generateBtn) generateBtn.disabled = true
    spinner?.removeAttribute('hidden')
    setStatus('Matching…')
    if (result) result.textContent = ''
    try {
      rawById = await matchAudioRawById(f)
      patchName = 'AI MATCH'
      emit('patch:load', {
        patch: rawByIdToPatch(rawById, patchName),
        rawById,
        index: 0,
        total: 1,
      })
      if (result) {
        result.textContent = 'Patch loaded — try it on your minilogue xd.'
      }
      feedback?.removeAttribute('hidden')
      if (turnstileBox) void mountTurnstile(turnstileBox)
      setStep('try')
      setStatus('Done.')
      updateLoad()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('')
      toast(message, 'danger')
    } finally {
      spinner?.setAttribute('hidden', '')
      updateGenerate()
    }
  })

  // 'adjusted' uploads the synth's live current program — a fresh dump, so every param reflects the
  // actual hardware: the values you adjusted AND the preset values for everything you didn't touch.
  const submit = async (kind: Rating): Promise<void> => {
    if (!file) return
    let submitRaw = rawById
    if (kind === 'adjusted') {
      if (!link.getTemplate()) {
        toast(
          'Connect your minilogue xd and load the patch first so we can capture your changes.',
          'danger',
        )
        return
      }
      const fresh = (await link.requestDump()) ?? link.getTemplate()
      if (!fresh) return
      submitRaw = readRawById(fresh) // full current hardware edit buffer, every param
    }
    if (!submitRaw) return

    if (asIsBtn) asIsBtn.disabled = true
    if (mineBtn) mineBtn.disabled = true
    const markDone = (): void => {
      setStep('feedback')
      stepEls
        .find((li) => li.dataset.step === 'feedback')
        ?.classList.add('done')
    }
    const reenable = (): void => {
      if (asIsBtn) asIsBtn.disabled = false
      if (mineBtn) mineBtn.disabled = false
    }

    const tsToken = turnstileToken()
    if (turnstileEnabled() && !tsToken) {
      setStatus('Please complete the verification challenge first.')
      reenable()
      return
    }
    setStatus('Sending feedback…')
    try {
      const id = await submitContribution({
        file,
        rawById: submitRaw,
        name: patchName,
        pitchMidi: Number(pitchSel?.value ?? 60),
        model: BUILTIN_MODEL,
        engine: 'builtin',
        rating: kind,
        turnstileToken: tsToken,
      })
      resetTurnstile()
      markDone()
      setStatus(
        `Thanks! ${kind === 'adjusted' ? 'Your version' : 'Feedback'} sent (${id}).`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('')
      toast(`Could not send feedback: ${message}`, 'danger')
      reenable()
    }
  }
  asIsBtn?.addEventListener('click', () => void submit('as-is'))
  mineBtn?.addEventListener('click', () => void submit('adjusted'))

  // MIDI status + live mirroring are owned by the viewer's shared synth link; we only track connection here.
  on('midi:status', ({ state }) => {
    connected = state === 'connected'
    updateLoad()
    mineBtn?.toggleAttribute('hidden', !connected)
  })
  loadBtn?.addEventListener('click', () => {
    const t = link.getTemplate()
    if (!t || !rawById) return
    const ok = link.sendProgram(writeProgBin(t, rawById))
    setStatus(
      ok
        ? 'Loaded to your minilogue xd — play a note to hear it.'
        : 'No minilogue xd output found.',
    )
  })

  updateGenerate()
  setStep('upload')
  updateLoad()
}
