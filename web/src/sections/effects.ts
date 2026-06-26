import { emit, on } from '../events/bus'
import type { ParamChange } from '../events/types'

type Slot = 'modFx' | 'delay' | 'reverb'
const SLOTS: readonly Slot[] = ['modFx', 'delay', 'reverb']
const isSlot = (s: string): s is Slot =>
  (SLOTS as readonly string[]).includes(s)

type Layer = Record<Slot, { time?: ParamChange; depth?: ParamChange }>
const emptyLayer = (): Layer => ({ modFx: {}, delay: {}, reverb: {} })

// Slot time/depth arrives via CC 28/29 (modFx) · 105/106 (delay) · 108/109 (reverb);
// the active slot is re-emitted under section "fx" onto the shared TIME/DEPTH knobs.
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
      // A live value differing from the program selects that slot; a dump seed (live == program) does not.
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
