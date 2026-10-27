export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

// Each linked signal's controller, kept as long as the signal: the caller's listener holds the signal only weakly, so
// it never keeps alive a signal nothing else holds.
const controllers = new WeakMap<AbortSignal, AbortController>()

// The caller's listener goes once its linked signal is collected: a long-lived caller signal, such as a shutdown signal
// shared by every call, would otherwise keep one per call that ever returned.
const unlinks = new FinalizationRegistry<() => void>(unlink => unlink())

/**
 * A signal that aborts when the caller's signal or the attempt's signal does, with that signal's reason.
 *
 * It stays linked to the caller after the attempt settles, so work the method handed back, such as a streamed body,
 * still learns that the caller left.
 */
export function linked(caller: AbortSignal, attempt: AbortSignal): AbortSignal {
  if (attempt.aborted) {
    return attempt
  }
  if (caller.aborted) {
    return caller
  }

  const controller = new AbortController()
  const signal = controller.signal
  controllers.set(signal, controller)

  const ref = new WeakRef(signal)
  const onCaller = (): void => {
    const held = ref.deref()
    if (held !== undefined) {
      controllers.get(held)?.abort(caller.reason)
    }
  }
  caller.addEventListener('abort', onCaller, { once: true })
  attempt.addEventListener(
    'abort',
    () => {
      caller.removeEventListener('abort', onCaller)
      controller.abort(attempt.reason)
    },
    { once: true },
  )
  unlinks.register(signal, () => caller.removeEventListener('abort', onCaller))

  return signal
}
