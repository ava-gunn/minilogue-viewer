import type { AppEvent, AppEventMap } from './types'

type Handler<E extends AppEvent> = (payload: AppEventMap[E]) => void

// Handlers are stored loosely keyed; the public API keeps them type-safe.
const registry = new Map<AppEvent, Set<Handler<AppEvent>>>()

/**
 * Subscribe to an event. Returns an unsubscribe function.
 * Safe to unsubscribe (including self) during dispatch.
 */
export function on<E extends AppEvent>(
  event: E,
  handler: Handler<E>,
): () => void {
  let handlers = registry.get(event)
  if (!handlers) {
    handlers = new Set()
    registry.set(event, handlers)
  }
  handlers.add(handler as Handler<AppEvent>)
  return () => {
    registry.get(event)?.delete(handler as Handler<AppEvent>)
  }
}

/** Synchronously dispatch an event to all current subscribers. */
export function emit<E extends AppEvent>(
  event: E,
  payload: AppEventMap[E],
): void {
  const handlers = registry.get(event)
  if (!handlers) return
  // Iterate a snapshot so handlers may (un)subscribe during dispatch.
  for (const handler of [...handlers]) {
    ;(handler as Handler<E>)(payload)
  }
}

/** Remove all subscribers. Primarily for test isolation. */
export function clear(): void {
  registry.clear()
}
