import { emit } from './bus'

export const DEFAULT_ACCEPT = '.mnlgxdprog,.mnlgxdlib'

/** Validate a chosen/dropped file by extension and emit the right event. */
export function acceptFile(file: File, accept: string = DEFAULT_ACCEPT): void {
  const exts = accept.split(',').map((s) => s.trim().toLowerCase())
  const ok = exts.some((ext) => file.name.toLowerCase().endsWith(ext))
  if (ok) {
    emit('file:dropped', { file })
  } else {
    emit('file:error', {
      message: `Unsupported file: ${file.name} (expected ${accept})`,
    })
  }
}
