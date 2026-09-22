import type { CacheOperation } from './observer.js'

/** Reported to `CacheObserver.onError` for a store call that did not settle within `storeTimeout`. */
export class ErrCacheStoreTimeout extends Error {
  readonly code = 'ERR_CACHE_STORE_TIMEOUT'

  constructor(operation: CacheOperation, ms: number) {
    super(`Cannot wait for the cache store: "${operation}" did not settle within ${ms}ms`)
    this.name = 'ErrCacheStoreTimeout'
  }
}

/**
 * Runs one store call under the signal it is owed: the request's, `storeTimeout`'s, both, or none.
 *
 * With no timeout the call is handed the request signal as is — no timer, no promise of this function's own.
 * With one, the call gets a signal of its own that aborts with either, and the promise handed back rejects with
 * {@link ErrCacheStoreTimeout} when the timeout is what aborted it, or with the request signal's reason
 * otherwise; a request already over is rejected with its reason and the store is not called. The hook's listener
 * is registered ahead of the store's, so the store's own abort rejection, which arrives second, lands on a
 * promise already settled. Nothing outlives the call: its timer and listeners go when it settles.
 */
export function withStoreSignal<T>(
  operation: CacheOperation,
  requestSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  call: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) {
    return call(requestSignal)
  }

  if (requestSignal?.aborted) {
    return Promise.reject(requestSignal.reason)
  }

  const controller = new AbortController()
  const { signal } = controller
  const timer = setTimeout(() => controller.abort(new ErrCacheStoreTimeout(operation, timeoutMs)), timeoutMs)
  timer.unref()

  const onRequestAbort = () => controller.abort(requestSignal!.reason)
  requestSignal?.addEventListener('abort', onRequestAbort, { once: true })

  return new Promise<T>((resolve, reject) => {
    function settle() {
      clearTimeout(timer)
      requestSignal?.removeEventListener('abort', onRequestAbort)
      signal.removeEventListener('abort', onAbort)
    }

    function onAbort() {
      settle()
      reject(signal.reason)
    }

    signal.addEventListener('abort', onAbort, { once: true })

    let pending: Promise<T>
    try {
      pending = call(signal)
    } catch (error) {
      settle()
      reject(error)
      return
    }

    pending.then(
      value => {
        settle()
        resolve(value)
      },
      (error: unknown) => {
        settle()
        reject(error)
      },
    )
  })
}
