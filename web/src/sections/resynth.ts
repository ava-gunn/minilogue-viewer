// Re-synthesis view controller: pick the built-in model or Gemini, upload + audition an
// audio clip (waveform + play), generate a patch onto the shared Korg panel, then submit
// thumbs-up/down feedback. Drives the panel through the same patch:load event the viewer
// uses; the engines converge on a rawById map (see inference/decode + gemini/schema).

// Loaded lazily on first Resynthesis click — its CSS rides along in this chunk so the viewer's
// initial bundle stays free of the form styles.
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
import { isLocalhost, verifyOnHardware } from '../services/verify'

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

// Render the rationale plus Gemini's structured audio analysis (one line per heard trait) into
// the result box; .resynth-result uses white-space: pre-line so the newlines show.
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

  // Load-to-hardware: the shared synth link supplies the live program (template) + sendProgram.
  let connected = false
  // The button only shows when an xd is connected; enabled once we also have a captured
  // template (the synth's live program) and a generated patch.
  const updateLoad = (): void => {
    loadBtn?.toggleAttribute('hidden', !connected)
    if (loadBtn) loadBtn.disabled = !(connected && link.getTemplate() && rawById)
  }

  // ---- engine selector + credentials ---------------------------------------
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
    if (gemini) {
      if (keyInput) keyInput.value = getApiKey()
      if (modelSel) modelSel.value = getModel()
    }
  }
  builtinRadio?.addEventListener('change', syncEngine)
  geminiRadio?.addEventListener('change', syncEngine)
  keyInput?.addEventListener('input', () => setApiKey(keyInput.value.trim()))
  modelSel?.addEventListener('change', () => setModel(modelSel.value))

  // ---- audio preview (waveform + audition) ---------------------------------
  // Whether the canvas holds a real decoded waveform (vs a flat baseline / nothing) — we only
  // ship the screenshot to Gemini when it's meaningful — plus the clip duration for envelope scaling.
  let waveformOk = false
  let waveformDuration = 0
  // Whether drawWaveform has finished for the current file (success or fail) — gates Generate so
  // the waveform screenshot is ready before we send.
  let waveformReady = false

  // Generate is enabled when there's a ready audio waveform OR a non-empty text description.
  const updateGenerate = (): void => {
    const hasText = !!textInput?.value.trim()
    if (generateBtn) generateBtn.disabled = !((file && waveformReady) || hasText)
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

  // Snapshot the rendered waveform as a base64 PNG (no data: prefix) for Gemini — the visible
  // amplitude envelope is exactly what it needs to read the AMP EG correctly.
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
      // Waveform ready (or decode failed) → safe to generate. Enable even on failure so the
      // audio can still be sent; the screenshot is simply omitted when there's nothing to grab.
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

  // ---- audio / text input (mutually exclusive) -----------------------------
  // Whichever input has content disables the other.
  const syncInputs = (): void => {
    const hasText = !!textInput?.value.trim()
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
    // Swap back: hide the waveform, restore the drop.
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
    // The waveform replaces the drop in-place; hide the drop, loadPreview shows the preview.
    drop?.setAttribute('hidden', '')
    // syncInputs disables the text box; Generate stays off until the waveform renders (then
    // loadPreview's drawWaveform().finally re-enables it), so the screenshot is always included.
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

  // ---- generate patch ------------------------------------------------------
  generateBtn?.addEventListener('click', async () => {
    const text = textInput?.value.trim() ?? ''
    const f = file
    if (!f && !text) return
    const eng = engine()
    const useText = !f
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
      // A pure text patch has no audio to contribute — show the result but hide the thumbs row
      // (and skip the captcha). Audio patches keep the full feedback/contribution flow.
      feedback?.removeAttribute('hidden')
      feedbackRow?.toggleAttribute('hidden', useText)
      if (!useText && !isLocalhost() && turnstileBox) {
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

  // ---- feedback: contribute the patch -------------------------------------
  // 'as-is' uploads the generated patch; 'adjusted' uploads the user's live hardware program
  // (the generated patch + their knob tweaks), read back from the connected XD.
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
      stepEls.find((li) => li.dataset.step === 'feedback')?.classList.add('done')
    }
    const reenable = (): void => {
      if (asIsBtn) asIsBtn.disabled = false
      if (mineBtn) mineBtn.disabled = false
    }

    // On localhost the local daemon loads the params on the connected XD, records, scores the
    // match, and folds verified patches into the built-in model's training set.
    if (isLocalhost()) {
      setStatus(
        kind === 'adjusted'
          ? 'Verifying your version on the XD…'
          : 'Verifying on your minilogue xd…',
      )
      try {
        const r = await verifyOnHardware({
          file,
          rawById: submitRaw,
          pitchMidi: Number(pitchSel?.value ?? 60),
          engine: engine(),
        })
        markDone()
        setStatus(
          r.promoted
            ? `Verified ✓ mel_l1 ${r.mel_l1} (weight ${r.weight}) — added to training (${r.verified_total} verified).`
            : `Didn’t match on the XD (mel_l1 ${r.mel_l1}) — not added.`,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus('')
        toast(
          `Local verify failed: ${message}. Is the daemon running? (pnpm daemon:start)`,
          'danger',
        )
        reenable()
      }
      return
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
      setStatus(`Thanks! ${kind === 'adjusted' ? 'Your version' : 'Feedback'} sent (${id}).`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('')
      toast(`Could not send feedback: ${message}`, 'danger')
      reenable()
    }
  }
  asIsBtn?.addEventListener('click', () => void submit('as-is'))
  mineBtn?.addEventListener('click', () => void submit('adjusted'))

  // ---- load to hardware ----------------------------------------------------
  // MIDI status + live mirroring are owned by the always-loaded viewer (the shared synth link);
  // here we only track connection state for the Load / "Mine's better" buttons and send the
  // generated patch via the link.
  on('midi:status', ({ state }) => {
    connected = state === 'connected'
    updateLoad()
    // "Mine's better" reads the live program off the XD, so it only makes sense when connected.
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

  // initial state
  syncEngine()
  setStep('upload')
  updateLoad()
}
