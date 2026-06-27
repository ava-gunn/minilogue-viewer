// Both engines (built-in model, Gemini) converge on a rawById map; see inference/decode + gemini/schema.

// CSS rides along in this lazily-loaded chunk so the viewer's initial bundle stays free of the form styles.
import '../styles/resynth.css'

import { emit, on } from '../events/bus'
import { AUDIO_ACCEPT } from '../events/files'
import { matchAudioRawById } from '../inference'
import { rawByIdToPatch } from '../inference/decode'
import { readRawById, writeProgBin } from '../parser/write'
import {
  getApiKey,
  getModel,
  hasApiKey,
  setApiKey,
  setModel,
} from '../services/api-key'
import {
  type Engine,
  type Rating,
  submitContribution,
} from '../services/contribute'
import { analyzeAudio, analyzeText, MODELS } from '../services/gemini'
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
let lastRationale: string | undefined
let lastAnalysis: Record<string, string> | undefined
let objectUrl: string | undefined

// .resynth-result uses white-space: pre-line, so the newlines below render as line breaks.
const ANALYSIS_LABELS: Record<string, string> = {
  sound_type: 'Type',
  pitch: 'Pitch',
  dynamics: 'Dynamics',
  brightness: 'Brightness',
  harmonics: 'Harmonics',
  movement: 'Movement',
  effects: 'Effects',
  envelope: 'Envelope',
  voice: 'Voice',
}
function formatResult(
  rationale: string | undefined,
  analysis: Record<string, string> | undefined,
): string {
  const blocks: string[] = []
  if (rationale) blocks.push(rationale)
  if (analysis) {
    const lines = Object.entries(analysis)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `${ANALYSIS_LABELS[k] ?? k}: ${v}`)
    if (lines.length) blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

export function initResynth(link: SynthLink): void {
  const stepEls = Array.from(
    document.querySelectorAll<HTMLLIElement>('#resynth-steps li'),
  )
  if (stepEls.length === 0) return // not on this page

  const builtinRadio = byId<HTMLInputElement>('engine-builtin')
  const geminiRadio = byId<HTMLInputElement>('engine-gemini')
  const creds = byId('gemini-creds')
  const keyInput = byId<HTMLInputElement>('gemini-key')
  const modelSel = byId<HTMLSelectElement>('gemini-model')

  const drop = byId('resynth-drop')
  const fileBtn = byId<HTMLButtonElement>('resynth-file-btn')
  const fileInput = byId<HTMLInputElement>('resynth-file')
  const filename = byId('resynth-filename')
  const clearBtn = byId<HTMLButtonElement>('resynth-clear')
  const textInput = byId<HTMLTextAreaElement>('resynth-text')
  const textWrap = byId('resynth-text-wrap')
  const orSep = byId('resynth-or')

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
  const feedbackRow = byId('resynth-feedback-row')
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
  const engine = (): Engine => (geminiRadio?.checked ? 'gemini' : 'builtin')

  let connected = false
  const updateLoad = (): void => {
    // Read live state (a captured template implies a connected+dumped synth) rather than the
    // `connected` event — initResynth is lazy and can miss it if MIDI connected before opening.
    const ready = !!(link.getTemplate() && rawById)
    loadBtn?.toggleAttribute('hidden', !ready)
    if (loadBtn) loadBtn.disabled = !ready
  }

  if (modelSel && modelSel.options.length === 0) {
    for (const m of MODELS) {
      const opt = document.createElement('option')
      opt.value = m
      opt.textContent = m
      modelSel.append(opt)
    }
  }
  const syncEngine = (): void => {
    const gemini = engine() === 'gemini'
    creds?.toggleAttribute('hidden', !gemini)
    // Text -> params is Gemini-only; the built-in model matches from audio, so hide the
    // "or / Describe a patch" input for it.
    textWrap?.toggleAttribute('hidden', !gemini)
    orSep?.toggleAttribute('hidden', !gemini)
    if (gemini) {
      if (keyInput) keyInput.value = getApiKey()
      if (modelSel) modelSel.value = getModel()
    }
    updateGenerate()
  }
  builtinRadio?.addEventListener('change', syncEngine)
  geminiRadio?.addEventListener('change', syncEngine)
  keyInput?.addEventListener('input', () => setApiKey(keyInput.value.trim()))
  modelSel?.addEventListener('change', () => setModel(modelSel.value))

  // waveformOk gates whether the screenshot is sent to Gemini; waveformDuration scales the envelope.
  let waveformOk = false
  let waveformDuration = 0
  // Gates Generate until drawWaveform has finished, so the screenshot is ready before we send.
  let waveformReady = false

  const updateGenerate = (): void => {
    const hasText = engine() === 'gemini' && !!textInput?.value.trim()
    if (generateBtn)
      generateBtn.disabled = !((file && waveformReady) || hasText)
  }

  async function drawWaveform(f: File): Promise<void> {
    waveformOk = false
    waveformDuration = 0
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
      waveformDuration = buf.duration
    } catch {
      // Undecodable here (Gemini may still accept it) — show a flat baseline.
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
    waveformOk = true
  }

  // Base64 PNG of the rendered waveform, no data: prefix (Gemini wants the bare payload).
  const waveformPng = (): string | undefined => {
    if (!canvas || !waveformOk) return undefined
    try {
      const url = canvas.toDataURL('image/png')
      return url.slice(url.indexOf(',') + 1) || undefined
    } catch {
      return undefined
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
      // Enable even on decode failure: the audio can still be sent, just without the screenshot.
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

  // Audio and text inputs are mutually exclusive: content in one disables the other.
  const syncInputs = (): void => {
    const hasText = engine() === 'gemini' && !!textInput?.value.trim()
    if (textInput) textInput.disabled = !!file
    if (fileBtn) fileBtn.disabled = hasText
    drop?.classList.toggle('disabled', hasText)
    updateGenerate()
  }

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
    syncInputs()
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
    syncInputs()
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
  textInput?.addEventListener('input', syncInputs)
  clearBtn?.addEventListener('click', clearAudio)

  generateBtn?.addEventListener('click', async () => {
    const text = textInput?.value.trim() ?? ''
    const f = file
    if (!f && !text) return
    const eng = engine()
    const useText = !f && eng === 'gemini'
    // Text generation is Gemini-only; audio uses the selected engine. Either way Gemini needs a key.
    if (!hasApiKey() && (useText || eng === 'gemini')) {
      setStatus('Enter your Gemini API token first.')
      keyInput?.focus()
      return
    }
    if (generateBtn) generateBtn.disabled = true
    spinner?.removeAttribute('hidden')
    setStatus(
      useText
        ? 'Designing…'
        : eng === 'gemini'
          ? `Asking ${getModel()}…`
          : 'Matching…',
    )
    if (result) result.textContent = ''
    try {
      let name: string | undefined
      let rationale: string | undefined
      let analysis: Record<string, string> | undefined
      if (useText) {
        const program = await analyzeText(text, {
          apiKey: getApiKey(),
          model: getModel(),
          onProgress: setStatus,
        })
        rawById = program.rawById
        name = program.name
        rationale = program.rationale
      } else if (f && eng === 'gemini') {
        const program = await analyzeAudio(f, {
          apiKey: getApiKey(),
          model: getModel(),
          waveformPng: waveformPng(),
          durationSec: waveformDuration || undefined,
          onProgress: setStatus,
        })
        rawById = program.rawById
        name = program.name
        rationale = program.rationale
        analysis = program.analysis
      } else if (f) {
        rawById = await matchAudioRawById(f)
        name = 'AI MATCH'
      } else {
        return
      }
      patchName = name
      lastRationale = rationale
      lastAnalysis = analysis
      emit('patch:load', {
        patch: rawByIdToPatch(rawById, name ?? 'AI MATCH'),
        index: 0,
        total: 1,
      })
      if (result) {
        result.textContent =
          formatResult(rationale, analysis) ||
          'Patch loaded — try it on your minilogue xd.'
      }
      // A pure text patch has no audio to contribute: hide the thumbs row and skip the captcha.
      feedback?.removeAttribute('hidden')
      feedbackRow?.toggleAttribute('hidden', useText)
      if (!useText && turnstileBox) {
        void mountTurnstile(turnstileBox)
      }
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

  // 'adjusted' uploads the live hardware program (generated patch + knob tweaks) read back from the XD.
  const submit = async (kind: Rating): Promise<void> => {
    if (!file) return
    let submitRaw = rawById
    if (kind === 'adjusted') {
      const t = link.getTemplate()
      if (!t) {
        toast(
          'Connect your minilogue xd and load the patch first so we can capture your changes.',
          'danger',
        )
        return
      }
      submitRaw = readRawById(t) // current edit buffer = generated + the user's tweaks
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
        model: getModel(),
        engine: engine(),
        rating: kind,
        analysis: lastAnalysis,
        rationale: lastRationale,
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

  syncEngine()
  setStep('upload')
  updateLoad()
}
