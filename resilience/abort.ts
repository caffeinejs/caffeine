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

  // Each callback is made in a function of its own: closures made in one function share its scope, and one that
  // held the controller would keep every other alive with it, the signal included.
  const onCaller = callerListener(caller, new WeakRef(signal))
  caller.addEventListener('abort', onCaller, { once: true })
  attempt.addEventListener('abort', attemptListener(caller, onCaller, attempt, controller), { once: true })
  unlinks.register(signal, unlink(caller, onCaller))

  return signal
}

function callerListener(caller: AbortSignal, ref: WeakRef<AbortSignal>): () => void {
  return () => {
    const held = ref.deref()
    if (held !== undefined) {
      controllers.get(held)?.abort(caller.reason)
    }
  }
}

function attemptListener(
  caller: AbortSignal,
  onCaller: () => void,
  attempt: AbortSignal,
  controller: AbortController,
): () => void {
  return () => {
    caller.removeEventListener('abort', onCaller)
    controller.abort(attempt.reason)
  }
}

function unlink(caller: AbortSignal, onCaller: () => void): () => void {
  return () => caller.removeEventListener('abort', onCaller)
}
