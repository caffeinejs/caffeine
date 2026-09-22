import type { InjectionToken } from '@caffeinejs/di'
import type { Duration } from '@caffeinejs/std'
import type { ByteSize } from '@caffeinejs/std/bytes'

import type { ETagGenerator } from './cache.js'
import type { CacheObserver } from './observer.js'
import type { HTTPCachingOptions } from './options.js'
import type { HTTPCacheStore } from './store.js'

/**
 * Materializes a {@link HTTPCachingOptionsBuilder} into the {@link HTTPCachingOptions} it built.
 *
 * A symbol, not a public `.build()` method: the builder's only public surface is the fluent setters, so a
 * plain `.build()` alongside them would read as one more chainable option rather than the terminal call it is.
 */
export const kBuild = Symbol('caffeine.caching.build')

/** Fluent authoring for {@link HTTPCachingOptions}, e.g. `HTTPCaching(b => b.store(myStore))`. */
export class HTTPCachingOptionsBuilder {
  #store: HTTPCacheStore | InjectionToken<HTTPCacheStore> | undefined
  #etagGenerator: ETagGenerator | InjectionToken<ETagGenerator> | undefined
  #statusHeader: string | undefined
  #observer: CacheObserver | InjectionToken<CacheObserver> | undefined
  #storeTimeout: Duration | undefined
  #varyByQuery: string[] | undefined
  #maxEntrySize: ByteSize | undefined

  /** The store backing cached responses, or a token to resolve one from the container. */
  store(store: HTTPCacheStore | InjectionToken<HTTPCacheStore>): this {
    this.#store = store
    return this
  }

  /** The function hashing a payload into an `ETag`, or a token to resolve one from the container. */
  etagGenerator(generator: ETagGenerator | InjectionToken<ETagGenerator>): this {
    this.#etagGenerator = generator
    return this
  }

  /** Sets the cache-status response header name (default `X-Cache`), carrying HIT/MISS/BYPASS. */
  statusHeader(name: string): this {
    this.#statusHeader = name
    return this
  }

  /** Notified of every cache outcome, or a token to resolve one from the container. */
  observer(observer: CacheObserver | InjectionToken<CacheObserver>): this {
    this.#observer = observer
    return this
  }

  /** How long one store call may take before the request goes on without the cache. No default. */
  storeTimeout(timeout: Duration): this {
    this.#storeTimeout = timeout
    return this
  }

  /** The query parameters a store key carries, for every route that does not list its own. `[]` leaves the query out. */
  varyByQuery(names: string[]): this {
    this.#varyByQuery = names
    return this
  }

  /** The largest payload stored; a larger response goes out and is not stored. */
  maxEntrySize(size: ByteSize): this {
    this.#maxEntrySize = size
    return this
  }

  [kBuild](): HTTPCachingOptions {
    return {
      store: this.#store,
      etagGenerator: this.#etagGenerator,
      statusHeader: this.#statusHeader,
      observer: this.#observer,
      storeTimeout: this.#storeTimeout,
      varyByQuery: this.#varyByQuery,
      maxEntrySize: this.#maxEntrySize,
    }
  }
}
