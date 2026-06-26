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

/** Read-only viewer: events flow from a dropped file toward the panel; no editing/output events. */
export interface AppEventMap {
  'file:dropped': { file: File }
  'audio:dropped': { file: File }
  'file:parsed-lib': { name: string; patches: MinilogueXDPatch[] }
  'patch:load': { patch: MinilogueXDPatch; index: number; total: number }
  'param:change': ParamChange
  /** Live value from the connected synth's physical control (mirrors a CC). */
  'param:live': ParamChange
  'file:error': { message: string }
  /** Live-MIDI connection state, for the /live page status indicator. */
  'midi:status': {
    state:
      | 'unsupported'
      | 'requesting'
      | 'denied'
      | 'no-device'
      | 'connected'
      | 'error'
    device?: string
    detail?: string
  }
  /** User picked which effect slot the TIME/DEPTH knobs show. */
  'fx:select': { effect: string }
  /** The effect slot now driving TIME/DEPTH (from a click or a live edit). */
  'fx:active': { effect: string }
}

export type AppEvent = keyof AppEventMap
