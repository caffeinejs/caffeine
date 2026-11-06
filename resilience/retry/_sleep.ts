import type { Clock } from '../timers.js'

// Resolves after `ms`, or rejects with the abort reason as soon as the signal aborts. Leaves no timer and no
// listener behind either way. The timer keeps the process alive: a pending retry is pending work.
export function sleep(ms: number, signal: AbortSignal | undefined, clock: Clock): Promise<void> {
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(signal.reason)
  }

  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clock.clearTimeout(timer)
      reject(signal!.reason)
    }

    const timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
