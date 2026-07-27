/**
 * Resolves after `ms` milliseconds, or rejects immediately if `signal` is (or becomes) aborted
 * before the timer elapses.
 */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
