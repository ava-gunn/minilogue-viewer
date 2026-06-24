import { emit } from './bus'

export const PATCH_ACCEPT = '.mnlgxdprog,.mnlgxdlib'
export const AUDIO_ACCEPT = '.wav,.mp3,.flac,.ogg,.m4a,.aac'
export const DEFAULT_ACCEPT = `${PATCH_ACCEPT},${AUDIO_ACCEPT}`

const matches = (name: string, accept: string): boolean =>
  accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((ext) => name.toLowerCase().endsWith(ext))

/** Validate a chosen/dropped file by extension and route it: patch files parse into
 *  the panel; audio files go to the sound-matching inference path. */
export function acceptFile(file: File, accept: string = DEFAULT_ACCEPT): void {
  if (!matches(file.name, accept)) {
    emit('file:error', {
      message: `Unsupported file: ${file.name} (expected ${accept})`,
    })
    return
  }
  if (matches(file.name, AUDIO_ACCEPT)) {
    emit('audio:dropped', { file })
  } else {
    emit('file:dropped', { file })
  }
}
