// Minimal transient toast notifications — Web Awesome ships no toast/alert, so this is a tiny
// self-contained one. Used for API/network errors so they pop over the UI instead of sitting
// inline in the form.

export type ToastVariant = 'danger' | 'success' | 'info'

let stack: HTMLElement | undefined

function ensureStack(): HTMLElement {
  if (stack?.isConnected) return stack
  const el = document.createElement('div')
  el.className = 'toast-stack'
  el.setAttribute('aria-live', 'polite')
  document.body.append(el)
  stack = el
  return el
}

/** Show a toast that auto-dismisses after `timeout` ms (0 = sticky, dismiss via the ✕). */
export function toast(
  message: string,
  variant: ToastVariant = 'info',
  timeout = 6000,
): void {
  const item = document.createElement('div')
  item.className = `toast toast-${variant}`
  // Errors interrupt — announce them assertively; other variants are polite via the stack.
  if (variant === 'danger') item.setAttribute('role', 'alert')

  const text = document.createElement('span')
  text.className = 'toast-text'
  text.textContent = message

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'toast-close'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '✕'

  let done = false
  const dismiss = (): void => {
    if (done) return
    done = true
    item.classList.add('toast-leaving')
    setTimeout(() => item.remove(), 200)
  }
  close.addEventListener('click', dismiss)

  item.append(text, close)
  ensureStack().append(item)
  requestAnimationFrame(() => item.classList.add('toast-in'))
  if (timeout > 0) setTimeout(dismiss, timeout)
}
