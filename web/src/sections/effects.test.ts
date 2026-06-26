import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clear, emit, on } from '../events/bus'
import type { ParamChange } from '../events/types'
import { initEffects } from './effects'

describe('initEffects (effects focus)', () => {
  let fxChange: ParamChange[]
  let fxLive: ParamChange[]
  const offs: Array<() => void> = []

  beforeEach(() => {
    clear()
    initEffects()
    fxChange = []
    fxLive = []
    offs.push(
      on('param:change', (c) => {
        if (c.section === 'fx') fxChange.push(c)
      }),
      on('param:live', (c) => {
        if (c.section === 'fx') fxLive.push(c)
      }),
    )
  })
  afterEach(() => {
    for (const off of offs.splice(0)) off()
    clear()
  })

  const last = (list: ParamChange[], key: string): ParamChange | undefined =>
    list.filter((c) => c.key === key).at(-1)

  it('drives TIME/DEPTH from the reverb slot by default', () => {
    emit('param:change', { section: 'reverb', key: 'time', value: 0.5 })
    emit('param:change', { section: 'reverb', key: 'depth', value: 0.25 })
    expect(last(fxChange, 'time')?.value).toBe(0.5)
    expect(last(fxChange, 'depth')?.value).toBe(0.25)
  })

  it('switches TIME/DEPTH to the clicked effect', () => {
    emit('param:change', { section: 'delay', key: 'time', value: 0.8 })
    fxChange.length = 0
    emit('fx:select', { effect: 'delay' })
    expect(last(fxChange, 'time')?.value).toBe(0.8)
  })

  it('auto-selects the effect edited live', () => {
    emit('param:change', { section: 'delay', key: 'time', value: 0.1 })
    fxLive.length = 0
    emit('param:live', { section: 'delay', key: 'time', value: 0.9 })
    expect(last(fxLive, 'time')?.value).toBe(0.9)
  })

  it('does not auto-select on a seed where live equals program', () => {
    emit('param:change', { section: 'modFx', key: 'time', value: 0.3 })
    fxChange.length = 0
    emit('param:live', { section: 'modFx', key: 'time', value: 0.3 })
    emit('param:change', { section: 'reverb', key: 'time', value: 0.7 })
    expect(last(fxChange, 'time')?.value).toBe(0.7)
  })
})
