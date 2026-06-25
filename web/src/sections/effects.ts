import { emit, on } from '../events/bus'
import type { ParamChange } from '../events/types'

type Slot = 'modFx' | 'delay' | 'reverb'
const SLOTS: readonly Slot[] = ['modFx', 'delay', 'reverb']
const isSlot = (s: string): s is Slot =>
  (SLOTS as readonly string[]).includes(s)

type Layer = Record<Slot, { time?: ParamChange; depth?: ParamChange }>
const emptyLayer = (): Layer => ({ modFx: {}, delay: {}, reverb: {} })

/**
 * Effects focus. The synth's TIME/DEPTH knobs are shared across the three
 * effect slots; the panel mirrors that with one TIME/DEPTH pair (section "fx").
 * Each slot's time/depth arrives as param:change (program) and param:live
 * (synth, from CC 28/29 · 105/106 · 108/109); this re-emits the active slot's
 * values under section "fx". The active slot follows a click (fx:select) or a
 * live edit (a CC whose value differs from the program).
 */
export function initEffects(): void {
  let active: Slot = 'reverb'
  const prog = emptyLayer()
  const live = emptyLayer()

  const fxEvent = (
    event: 'param:change' | 'param:live',
    key: 'time' | 'depth',
    c: ParamChange,
  ): void => {
    emit(
      event,
      c.display === undefined
        ? { section: 'fx', key, value: c.value }
        : { section: 'fx', key, value: c.value, display: c.display },
    )
  }

  function emitFx(): void {
    for (const key of ['time', 'depth'] as const) {
      const p = prog[active][key]
      if (p) fxEvent('param:change', key, p)
      const l = live[active][key]
      if (l) fxEvent('param:live', key, l)
    }
    emit('fx:active', { effect: active })
  }

  on('param:change', (c) => {
    if (isSlot(c.section) && (c.key === 'time' || c.key === 'depth')) {
      prog[c.section][c.key] = c
      if (c.section === active) emitFx()
    }
  })

  on('param:live', (c) => {
    if (isSlot(c.section) && (c.key === 'time' || c.key === 'depth')) {
      live[c.section][c.key] = c
      // A genuine live edit (differs from the program) selects that slot; a dump
      // seed (live == program) leaves the current selection alone.
      const p = prog[c.section][c.key]
      if (!p || p.value !== c.value) active = c.section
      emitFx()
    }
  })

  on('fx:select', ({ effect }) => {
    if (isSlot(effect)) {
      active = effect
      emitFx()
    }
  })
}
