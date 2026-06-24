import type { MinilogueXDPatch } from '../types/synth'

/** A single parameter update fanned out to the panel controls. */
export interface ParamChange {
  /** Control group, matches an element's `data-section`. */
  section: string
  /** Parameter within the section, matches `data-param-key`. */
  key: string
  /**
   * Normalized control value: 0..1 for knobs (mapped to rotation), or a
   * discrete index for switches / wave-selectors / LED groups.
   */
  value: number
  /** Human-readable readout for tooltips / the OLED (e.g. "42%", "+12¢"). */
  display?: string
}

/**
 * The full set of application events. Read-only viewer: events flow from a
 * dropped file toward the panel; there are no editing/output events.
 */
export interface AppEventMap {
  'file:dropped': { file: File }
  'audio:dropped': { file: File }
  'file:parsed-lib': { name: string; patches: MinilogueXDPatch[] }
  'patch:load': { patch: MinilogueXDPatch; index: number; total: number }
  'param:change': ParamChange
  'file:error': { message: string }
}

export type AppEvent = keyof AppEventMap
