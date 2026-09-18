import { abortReason } from '../abort.js'

// Resolves after `ms`, or rejects with the abort reason as soon as the signal aborts. Leaves no timer and no
// listener behind either way. The timer keeps the process alive: a pending retry is pending work.
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(abortReason(signal))
  }

  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
