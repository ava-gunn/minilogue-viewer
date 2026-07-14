import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MinilogueXDPatch } from '../types/synth'

// Module-level lock state persists, so reload a fresh module (and its fresh bus) per test.
async function setup() {
  vi.resetModules()
  const bus = await import('../events/bus')
  const { initLocks, applyLocks } = await import('./locks')
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  initLocks(root)
  bus.emit('midi:status', { state: 'connected' })
  return { bus, applyLocks, root }
}

function host(section: string, key: string): HTMLElement {
  const el = document.createElement('div')
  el.dataset.section = section
  el.dataset.paramKey = key
  return el
}

const program = (rawById: Record<string, number>) => ({
  patch: {} as unknown as MinilogueXDPatch,
  rawById,
  index: 0,
  total: 1,
})

describe('parameter locks', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('holds a locked param at its current value; randomizes the rest', async () => {
    const { bus, applyLocks, root } = await setup()
    bus.emit('patch:load', program({ cutoff: 800, resonance: 100 }))
    const cutoff = host('filter', 'cutoff') // path filter.cutoff -> id cutoff
    root.append(cutoff)
    cutoff.click()
    expect(cutoff.classList.contains('locked')).toBe(true)

    const fresh = applyLocks({ cutoff: 5, resonance: 5 })
    expect(fresh.cutoff).toBe(800) // held at the program value
    expect(fresh.resonance).toBe(5) // free to randomize
  })

  it('a second click unlocks', async () => {
    const { bus, applyLocks, root } = await setup()
    bus.emit('patch:load', program({ cutoff: 800 }))
    const cutoff = host('filter', 'cutoff')
    root.append(cutoff)
    cutoff.click()
    cutoff.click()
    expect(cutoff.classList.contains('locked')).toBe(false)
    expect(applyLocks({ cutoff: 5 }).cutoff).toBe(5)
  })

  it('a live knob turn overrides the patch value', async () => {
    const { bus, applyLocks, root } = await setup()
    bus.emit('patch:load', program({ cutoff: 800 }))
    bus.emit('param:hw', { id: 'cutoff', value: 900 }) // user dialled the knob to 900
    const cutoff = host('filter', 'cutoff')
    root.append(cutoff)
    cutoff.click()
    expect(applyLocks({ cutoff: 5 }).cutoff).toBe(900)
  })

  it('ignores a knob nudge on a param that is already locked', async () => {
    const { bus, applyLocks, root } = await setup()
    bus.emit('patch:load', program({ cutoff: 800 }))
    const cutoff = host('filter', 'cutoff')
    root.append(cutoff)
    cutoff.click() // lock at 800
    bus.emit('param:hw', { id: 'cutoff', value: 900 }) // nudge AFTER locking → ignored
    expect(applyLocks({ cutoff: 5 }).cutoff).toBe(800)
  })

  it('a new patch load clears the live override', async () => {
    const { bus, applyLocks, root } = await setup()
    bus.emit('patch:load', program({ cutoff: 800 }))
    bus.emit('param:hw', { id: 'cutoff', value: 900 })
    bus.emit('patch:load', program({ cutoff: 400 })) // fresh program supersedes the knob turn
    const cutoff = host('filter', 'cutoff')
    root.append(cutoff)
    cutoff.click()
    expect(applyLocks({ cutoff: 5 }).cutoff).toBe(400)
  })

  it('locks the shared FX knob against the active slot, and re-syncs on slot change', async () => {
    const { bus, applyLocks, root } = await setup()
    const fxTime = host('fx', 'time')
    root.append(fxTime)
    bus.emit('fx:active', { effect: 'delay' })
    bus.emit('patch:load', program({ delay_time: 700, reverb_time: 100 }))
    fxTime.click() // locks delay_time
    expect(fxTime.classList.contains('locked')).toBe(true)

    const fresh = applyLocks({ delay_time: 5, reverb_time: 5 })
    expect(fresh.delay_time).toBe(700) // held
    expect(fresh.reverb_time).toBe(5) // free

    bus.emit('fx:active', { effect: 'reverb' }) // knob now shows reverb (unlocked)
    expect(fxTime.classList.contains('locked')).toBe(false)
  })

  it('locks the MULTI shape against the active engine, and re-syncs on engine change', async () => {
    const { bus, applyLocks, root } = await setup()
    const shape = host('multi', 'shape')
    root.append(shape)
    bus.emit('patch:load', program({ multi_type: 1, multi_shape_vpm: 600 })) // VPM
    shape.click() // locks multi_shape_vpm
    expect(shape.classList.contains('locked')).toBe(true)
    expect(applyLocks({ multi_shape_vpm: 5 }).multi_shape_vpm).toBe(600)

    bus.emit('patch:load', program({ multi_type: 0 })) // NOISE — shape knob now unlocked
    expect(shape.classList.contains('locked')).toBe(false)
  })

  it('ignores the FX knob when the active slot has no model param (modFx)', async () => {
    const { bus, root } = await setup()
    const fxTime = host('fx', 'time')
    root.append(fxTime)
    bus.emit('fx:active', { effect: 'modFx' })
    fxTime.click()
    expect(fxTime.classList.contains('locked')).toBe(false)
  })

  it('does not lock while disconnected', async () => {
    const { bus, root } = await setup()
    bus.emit('midi:status', { state: 'no-device' })
    const cutoff = host('filter', 'cutoff')
    root.append(cutoff)
    cutoff.click()
    expect(cutoff.classList.contains('locked')).toBe(false)
  })
})
