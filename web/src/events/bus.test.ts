import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear, emit, on } from './bus'

afterEach(() => clear())

describe('event bus', () => {
  it('delivers a typed payload to a subscriber', () => {
    const handler = vi.fn()
    on('param:change', handler)

    emit('param:change', { section: 'filter', key: 'cutoff', value: 0.5 })

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      section: 'filter',
      key: 'cutoff',
      value: 0.5,
    })
  })

  it('delivers to multiple subscribers of the same event', () => {
    const a = vi.fn()
    const b = vi.fn()
    on('file:error', a)
    on('file:error', b)

    emit('file:error', { message: 'bad file' })

    expect(a).toHaveBeenCalledWith({ message: 'bad file' })
    expect(b).toHaveBeenCalledWith({ message: 'bad file' })
  })

  it('does not cross-deliver between events', () => {
    const handler = vi.fn()
    on('param:change', handler)

    emit('file:error', { message: 'nope' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn()
    const off = on('param:change', handler)

    off()
    emit('param:change', { section: 'lfo', key: 'rate', value: 0.2 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('lets a handler unsubscribe itself mid-dispatch without skipping others', () => {
    const order: string[] = []
    const off = on('param:change', () => {
      order.push('first')
      off()
    })
    on('param:change', () => order.push('second'))

    emit('param:change', { section: 'vco1', key: 'shape', value: 1 })
    emit('param:change', { section: 'vco1', key: 'shape', value: 0 })

    // Both run on the first emit; only the survivor runs on the second.
    expect(order).toEqual(['first', 'second', 'second'])
  })
})
