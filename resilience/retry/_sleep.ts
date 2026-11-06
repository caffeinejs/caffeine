import type { Clock } from '../timers.js'

/**
 * Calls `wake` after `ms`, or `abort` with the reason as soon as the signal aborts, and never before it returns.
 * Leaves no timer and no listener behind either way. The function it returns cancels the sleep without calling
 * either. The timer keeps the process alive: a pending retry is pending work.
 */
export function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  clock: Clock,
  wake: () => void,
  abort: (reason: unknown) => void,
): () => void {
  if ((signal !== undefined && signal.aborted) || ms <= 0) {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) {
        return
      }
      if (signal !== undefined && signal.aborted) {
        abort(signal.reason)
      } else {
        wake()
      }
    })
    return () => {
      cancelled = true
    }
  }

  const onAbort = (): void => {
    clock.clearTimeout(timer)
    abort(signal!.reason)
  }

  const timer = clock.setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    wake()
  }, ms)

  signal?.addEventListener('abort', onAbort, { once: true })
  return () => {
    clock.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
