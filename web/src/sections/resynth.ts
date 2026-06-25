// Re-synthesis view controller: pick the built-in model or Gemini, upload + audition an
// audio clip (waveform + play), generate a patch onto the shared Korg panel, then submit
// thumbs-up/down feedback. Drives the panel through the same patch:load event the viewer
// uses; the engines converge on a rawById map (see inference/decode + gemini/schema).

import { emit, on } from '../events/bus'
import { AUDIO_ACCEPT } from '../events/files'
import { matchAudioRawById } from '../inference'
import { rawByIdToPatch } from '../inference/decode'
import { writeProgBin } from '../parser/write'
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
import { analyzeAudio, MODELS } from '../services/gemini'
import { createLivePatch } from '../services/live-patch'
import { connectMidi, type MidiController } from '../services/midi'
import { toast } from '../services/toast'
import {
  mountTurnstile,
  resetTurnstile,
  turnstileEnabled,
  turnstileToken,
} from '../services/turnstile'
import { isLocalhost, verifyOnHardware } from '../services/verify'
import { initMidiStatus } from './midi-status'

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

export function initResynth(): void {
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
  const upBtn = byId<HTMLButtonElement>('resynth-up')
  const downBtn = byId<HTMLButtonElement>('resynth-down')
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

  // Load-to-hardware state: a template prog_bin captured from the connected synth's
  // current program, overwritten with the generated params and sent back.
  let midi: MidiController | undefined
  let connected = false
  let template: Uint8Array | undefined
  // The button only shows when an xd is connected; enabled once we also have a
  // captured template and a generated patch.
  const updateLoad = (): void => {
    loadBtn?.toggleAttribute('hidden', !connected)
    if (loadBtn) loadBtn.disabled = !(connected && template && rawById)
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
  }

  const loadPreview = (f: File): void => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(f)
    if (audio) audio.src = objectUrl
    if (playBtn) playBtn.textContent = '▶'
    if (progress) progress.style.width = '0%'
    preview?.removeAttribute('hidden')
    void drawWaveform(f)
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

  // ---- file selection ------------------------------------------------------
  const acceptAudio = (f: File): void => {
    if (!isAudio(f.name)) {
      setStatus(`Unsupported file: ${f.name}`)
      return
    }
    file = f
    rawById = undefined
    if (filename) filename.textContent = f.name
    if (generateBtn) generateBtn.disabled = false
    feedback?.setAttribute('hidden', '')
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

  // ---- generate patch ------------------------------------------------------
  generateBtn?.addEventListener('click', async () => {
    if (!file) return
    const eng = engine()
    if (eng === 'gemini' && !hasApiKey()) {
      setStatus('Enter your Gemini API token first.')
      keyInput?.focus()
      return
    }
    const f = file
    if (generateBtn) generateBtn.disabled = true
    spinner?.removeAttribute('hidden')
    setStatus(eng === 'gemini' ? `Asking ${getModel()}…` : 'Matching…')
    if (result) result.textContent = ''
    try {
      let name: string | undefined
      let rationale: string | undefined
      let analysis: Record<string, string> | undefined
      if (eng === 'gemini') {
        const program = await analyzeAudio(f, {
          apiKey: getApiKey(),
          model: getModel(),
        })
        rawById = program.rawById
        name = program.name
        rationale = program.rationale
        analysis = program.analysis
      } else {
        rawById = await matchAudioRawById(f)
        name = 'AI MATCH'
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
          'Patch loaded — try it on your minilogue xd, then rate it.'
      }
      feedback?.removeAttribute('hidden')
      // Remote submits need a captcha solve; mount the widget once feedback is shown
      // (skipped on localhost, which uses the hardware daemon instead).
      if (!isLocalhost() && turnstileBox) void mountTurnstile(turnstileBox)
      setStep('try')
      setStatus('Done.')
      updateLoad()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('')
      toast(message, 'danger')
    } finally {
      spinner?.setAttribute('hidden', '')
      if (generateBtn) generateBtn.disabled = false
    }
  })

  // ---- feedback (thumbs submit the contribution) ---------------------------
  const submit = async (rating: Rating): Promise<void> => {
    if (!file || !rawById) return
    if (upBtn) upBtn.disabled = true
    if (downBtn) downBtn.disabled = true

    // On localhost a thumbs-up runs the on-hardware verify+tune loop via the local daemon,
    // for either engine — the daemon loads the params on the connected XD, records, scores
    // the match, and folds verified patches into the built-in model's training set.
    if (isLocalhost()) {
      if (rating !== 'up') {
        setStep('feedback')
        stepEls
          .find((li) => li.dataset.step === 'feedback')
          ?.classList.add('done')
        setStatus('Thumbs-down noted — not sent to the XD.')
        return
      }
      setStatus('Verifying on your minilogue xd…')
      try {
        const r = await verifyOnHardware({
          file,
          rawById,
          pitchMidi: Number(pitchSel?.value ?? 60),
          engine: engine(),
        })
        setStep('feedback')
        stepEls
          .find((li) => li.dataset.step === 'feedback')
          ?.classList.add('done')
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
        if (upBtn) upBtn.disabled = false
        if (downBtn) downBtn.disabled = false
      }
      return
    }

    const tsToken = turnstileToken()
    if (turnstileEnabled() && !tsToken) {
      setStatus('Please complete the verification challenge first.')
      if (upBtn) upBtn.disabled = false
      if (downBtn) downBtn.disabled = false
      return
    }
    setStatus('Sending feedback…')
    try {
      const id = await submitContribution({
        file,
        rawById,
        name: patchName,
        pitchMidi: Number(pitchSel?.value ?? 60),
        model: getModel(),
        engine: engine(),
        rating,
        analysis: lastAnalysis,
        rationale: lastRationale,
        turnstileToken: tsToken,
      })
      resetTurnstile()
      setStep('feedback')
      stepEls
        .find((li) => li.dataset.step === 'feedback')
        ?.classList.add('done')
      setStatus(`Thanks! Feedback sent (${id}).`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('')
      toast(`Could not send feedback: ${message}`, 'danger')
      if (upBtn) upBtn.disabled = false
      if (downBtn) downBtn.disabled = false
    }
  }
  upBtn?.addEventListener('click', () => void submit('up'))
  downBtn?.addEventListener('click', () => void submit('down'))

  // ---- load to hardware ----------------------------------------------------
  // Shared MIDI status indicator (dot/text + refresh) — registered before connecting.
  initMidiStatus()
  on('midi:status', ({ state }) => {
    connected = state === 'connected'
    updateLoad()
  })
  loadBtn?.addEventListener('click', () => {
    if (!template || !rawById) return
    const ok = midi?.sendProgram(writeProgBin(template, rawById)) ?? false
    setStatus(
      ok
        ? 'Loaded to your minilogue xd — play a note to hear it.'
        : 'No minilogue xd output found.',
    )
  })
  byId<HTMLButtonElement>('midi-refresh')?.addEventListener('click', () =>
    midi?.refresh(),
  )
  // Mirror the connected synth's live knob moves onto the panel (so you can dial the proposed
  // patch into the hardware). The program needles show the GENERATED patch, so a dump only
  // sets the CC-decode baseline (setBaseline, no patch:load); each synth needle then appears
  // when its knob is physically moved (a CC).
  const live = createLivePatch()
  void (async () => {
    midi =
      (await connectMidi({
        onDump: (prog) => {
          template = prog // captured for the Load-patch button
          live.setBaseline(prog)
          updateLoad()
        },
        onPoll: (prog) => {
          template = prog
          updateLoad()
        },
        onControlChange: (cc, value) => live.controlChange(cc, value),
      })) ?? undefined
  })()

  // initial state
  syncEngine()
  setStep('upload')
  updateLoad()
}
