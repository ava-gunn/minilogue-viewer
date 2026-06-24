import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear, on } from './bus'
import { acceptFile } from './files'

afterEach(() => clear())

describe('acceptFile', () => {
  it('emits file:dropped for an accepted extension', () => {
    const dropped = vi.fn()
    on('file:dropped', dropped)

    const file = new File(['x'], 'lead.mnlgxdprog')
    acceptFile(file)

    expect(dropped).toHaveBeenCalledOnce()
    expect(dropped.mock.calls[0]?.[0].file).toBe(file)
  })

  it('accepts .mnlgxdlib too', () => {
    const dropped = vi.fn()
    on('file:dropped', dropped)

    acceptFile(new File(['x'], 'factory.mnlgxdlib'))

    expect(dropped).toHaveBeenCalledOnce()
  })

  it('emits file:error for an unsupported extension', () => {
    const dropped = vi.fn()
    const errored = vi.fn()
    on('file:dropped', dropped)
    on('file:error', errored)

    acceptFile(new File(['x'], 'notes.txt'))

    expect(dropped).not.toHaveBeenCalled()
    expect(errored).toHaveBeenCalledOnce()
    expect(errored.mock.calls[0]?.[0].message).toContain('notes.txt')
  })

  it('routes audio files to audio:dropped, not file:dropped', () => {
    const dropped = vi.fn()
    const audio = vi.fn()
    on('file:dropped', dropped)
    on('audio:dropped', audio)

    const file = new File(['x'], 'tone.wav')
    acceptFile(file)

    expect(dropped).not.toHaveBeenCalled()
    expect(audio).toHaveBeenCalledOnce()
    expect(audio.mock.calls[0]?.[0].file).toBe(file)
  })

  it('still routes patch files to file:dropped', () => {
    const dropped = vi.fn()
    const audio = vi.fn()
    on('file:dropped', dropped)
    on('audio:dropped', audio)

    acceptFile(new File(['x'], 'bass.mnlgxdprog'))

    expect(audio).not.toHaveBeenCalled()
    expect(dropped).toHaveBeenCalledOnce()
  })
})
