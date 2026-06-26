// The key is the user's own AI Studio key, sent only to Google by services/gemini.ts, never to our backend.

import { DEFAULT_MODEL } from './gemini'

const KEY = 'gemini-api-key'
const MODEL = 'gemini-model'

const store = (): Storage | undefined => {
  try {
    return window.localStorage
  } catch {
    return undefined // private mode / disabled storage
  }
}

export const getApiKey = (): string => store()?.getItem(KEY) ?? ''

export const setApiKey = (value: string): void => {
  const s = store()
  if (!s) return
  if (value) s.setItem(KEY, value)
  else s.removeItem(KEY)
}

export const getModel = (): string => store()?.getItem(MODEL) || DEFAULT_MODEL

export const setModel = (value: string): void => store()?.setItem(MODEL, value)

export const hasApiKey = (): boolean => getApiKey().length > 0
