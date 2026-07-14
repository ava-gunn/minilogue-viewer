// Parameter locks for the randomize button: click a control to hold its current value so
// the next random patch leaves it in place. The panel is a display (controls take no
// pointer input of their own), so a plain click has no editing role to collide with.
//
// The held value is the param's CURRENT value: the displayed program value, overridden by
// a live hardware knob turn when the user has dialled one in. FX TIME/DEPTH and MULTI
// shape/select are multiplexed/conditional, so they resolve to a concrete spec id via the
// active FX slot and multi engine.

import { on } from '../events/bus'
import { PARAM_SPEC } from '../parser/param-spec'

// A control carries data-section + data-param-key; PARAM_SPEC.path is `${section}.${key}`.
const PATH_TO_ID = new Map(PARAM_SPEC.map((p) => [p.path, p.id]))
const IDS = new Set(PARAM_SPEC.map((p) => p.id))
// multi_type index (MULTI_TYPE = [NOISE, VPM, USER]) → the per-engine id suffix.
const MULTI_ENGINES = ['noise', 'vpm', 'user'] as const

// Multiplexed controls whose locked id follows the active FX slot / multi engine — their
// .locked indicator is re-synced whenever the slot or engine changes.
const DYNAMIC_SELECTOR =
  '[data-section="fx"][data-param-key="time"],' +
  '[data-section="fx"][data-param-key="depth"],' +
  '[data-section="multi"][data-param-key="shape"],' +
  '[data-section="multi"][data-param-key="typeValue"]'

const locked = new Set<string>()
// The displayed program as raw-by-id (patch:load), and live hardware knob turns layered on
// top (param:hw). A knob turn overrides the patch value; a new patch:load clears the layer.
let programRaw: Record<string, number> = {}
let liveRaw: Record<string, number> = {}
let fxSlot = 'reverb' // effects.ts' default active slot

const currentValue = (id: string): number | undefined =>
  id in liveRaw ? liveRaw[id] : programRaw[id]

/** Resolve a control host to the model param id it locks, if any. */
function idFor(el: HTMLElement): string | undefined {
  const { section, paramKey: key } = el.dataset
  const direct = PATH_TO_ID.get(`${section}.${key}`)
  if (direct) return direct
  // Shared FX TIME/DEPTH knob → the active slot (modFx has no model time/depth param).
  if (section === 'fx' && (key === 'time' || key === 'depth')) {
    return PATH_TO_ID.get(`${fxSlot}.${key}`)
  }
  // MULTI shape / select depend on the active engine (NOISE / VPM / USER).
  if (section === 'multi' && (key === 'shape' || key === 'typeValue')) {
    const engine = MULTI_ENGINES[programRaw.multi_type ?? 0] ?? 'noise'
    const id = `${key === 'shape' ? 'multi_shape' : 'multi_select'}_${engine}`
    return IDS.has(id) ? id : undefined
  }
  return undefined
}

/** Overwrite the locked ids in a freshly randomized patch with their held values. */
export function applyLocks(
  fresh: Record<string, number>,
): Record<string, number> {
  for (const id of locked) {
    const v = currentValue(id)
    if (v !== undefined) fresh[id] = v
  }
  return fresh
}

function refresh(el: HTMLElement): void {
  const id = idFor(el)
  el.classList.toggle('locked', !!id && locked.has(id))
}

export function initLocks(root: HTMLElement): void {
  const syncDynamic = (): void => {
    for (const el of root.querySelectorAll<HTMLElement>(DYNAMIC_SELECTOR)) {
      refresh(el)
    }
  }

  on('patch:load', ({ rawById }) => {
    if (rawById) {
      programRaw = rawById
      liveRaw = {} // a new program supersedes prior knob turns
    }
    syncDynamic() // the multi engine may have changed
  })
  on('param:hw', ({ id, value }) => {
    // A locked param ignores hardware knob turns — its value stays frozen. (Turns made
    // BEFORE locking are captured, since the id isn't locked yet.)
    if (!locked.has(id)) liveRaw[id] = value
  })
  on('fx:active', ({ effect }) => {
    fxSlot = effect
    syncDynamic()
  })

  // Locking only does anything alongside the randomize button, which is connection-gated.
  let enabled = false
  on('midi:status', ({ state }) => {
    enabled = state === 'connected'
    root.classList.toggle('locks-enabled', enabled)
  })

  root.addEventListener('click', (e) => {
    if (!enabled) return
    const host = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-param-key]',
    )
    if (!host) return
    const id = idFor(host)
    if (!id) return // multiplexed control with no active model param
    if (locked.has(id)) locked.delete(id)
    else locked.add(id)
    refresh(host)
  })
}
