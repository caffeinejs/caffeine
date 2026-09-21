import type { CacheOperation } from './observer.js'

/** Reported to `CacheObserver.onError` for a store call that did not settle within `storeTimeout`. */
export class ErrCacheStoreTimeout extends Error {
  readonly code = 'ERR_CACHE_STORE_TIMEOUT'

  constructor(operation: CacheOperation, ms: number) {
    super(`Cannot wait for the cache store: "${operation}" did not settle within ${ms}ms`)
    this.name = 'ErrCacheStoreTimeout'
  }
}

// Without a timeout the call is handed back as it came: no timer, no promise of this function's own. With one,
// the call keeps its handlers after the timer won, so a store that rejects late rejects into nothing.
export function withStoreTimeout<T>(call: Promise<T>, operation: CacheOperation, ms: number | undefined): Promise<T> {
  if (ms === undefined) {
    return call
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ErrCacheStoreTimeout(operation, ms)), ms)
    timer.unref()

    call.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
