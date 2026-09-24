import type { InjectionToken } from '@caffeinejs/di'
import type { Duration } from '@caffeinejs/std'
import type { ByteSize } from '@caffeinejs/std/bytes'

import type { ETagGenerator } from './cache_control.js'
import type { CacheObserver } from './observer.js'
import type { HTTPCacheStore } from './store.js'

/** The default cache-status response header name, carrying HIT/MISS/STALE/BYPASS. */

export const DEFAULT_STATUS_HEADER = 'X-Cache'

/**
 * What `HTTPCaching(...)` takes: a plain options object, resolved once as the plugin registers.
 *
 * `store` and `etagGenerator` each accept either the value itself or an {@link InjectionToken} to read it
 * from the container at plugin-setup time — `HTTPCaching` never binds either into the container itself.
 */
export interface HTTPCachingOptions {
  /**
   * The store backing cached responses, or a token to resolve one from the container — `kHTTPCacheStore`, for
   * a store other code injects to evict by tag. A real {@link HTTPCacheStore} instance is told apart from an
   * {@link InjectionToken} by shape: a class, a `DeferredCtor`, or a string/symbol is a token, anything else (a
   * plain object) is the store itself. Required — installing `HTTPCaching` without one throws
   * `ErrConfiguration`.
   */
  store?: HTTPCacheStore | InjectionToken<HTTPCacheStore>
  /**
   * The function hashing a payload into an `ETag`, or a token to resolve one from the container — a
   * `string`/`symbol` is a token, a `function` is the generator itself. Defaults to an internal SHA-1 hash
   * when omitted; a token that resolves to nothing throws `ErrConfiguration`.
   *
   * The default tag is strong and hashed before any content-coding. Behind a plugin that compresses responses,
   * give a generator that returns weak tags (`W/"..."`), since the one tag then goes out with every coding.
   */
  etagGenerator?: ETagGenerator | InjectionToken<ETagGenerator>
  /** The cache-status response header name. Defaults to {@link DEFAULT_STATUS_HEADER}. */
  statusHeader?: string
  /**
   * Notified of every cache outcome on a route that declares caching, or a token to resolve one from the
   * container. Told apart from an {@link InjectionToken} by shape, the way {@link store} is. Omitted, the cache
   * hooks do no observer work at all; a token that resolves to nothing throws `ErrConfiguration`.
   */
  observer?: CacheObserver | InjectionToken<CacheObserver>
  /**
   * How long one store call may take. Past it the request goes on without the cache — a read is a miss, a write
   * or an eviction is skipped — and `observer.onError` is handed an `ErrCacheStoreTimeout`. Must be positive.
   *
   * Defaults to `2s`: a store that neither answers nor rejects, such as a client queueing commands while its
   * server is away, holds a request that long at most.
   */
  storeTimeout?: Duration
  /**
   * How long a request waits for another's handler run on the same key before running the handler itself.
   * Defaults to `10s`. Concurrent misses for one key run the handler once: the first leads, the rest wait for
   * what it stores. `@CacheControl({ lock: false })` takes a route out of it.
   */
  lockTimeout?: Duration
  /**
   * The query parameters a store key carries, for every route of this install that does not list its own.
   * Parameters outside the list, `utm_source` for one, do not fragment the cache. `[]` leaves the whole query
   * out; unset, the whole query counts.
   */
  varyByQuery?: string[]
  /**
   * The largest payload stored, as `'1MB'`, `'512kb'` or a number of bytes. A larger response goes out and is
   * not stored, reported to `observer.onSkip`. Unset, there is no limit.
   */
  maxEntrySize?: ByteSize
}
