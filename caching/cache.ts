import type { Duration } from '@caffeinejs/std/duration'

export interface CacheEntry {
  payload: string | Buffer
  /** Status code of the stored response, replayed as is on a hit. */
  statusCode: number
  etag?: string
  lastModified?: string
  /** Epoch milliseconds when the entry was stored; used to compute the `Age` header and honor request `max-age`. */
  storedAt?: number
  headers: Record<string, string | string[]>
}

/** One entry of a {@link Cache.putMany} batch. */
export interface CachePutItem {
  key: string
  entry: CacheEntry
  ttl: Duration
}

/**
 * Server-side store backing the cache feature.
 *
 * Implement it directly (`class RedisCache implements Cache`) and bind/pass the class as its own DI key:
 * `container.bind(RedisCache, t => t.toSelf())`, then `.store(RedisCache)`. A store must always be given
 * explicitly — see `HTTPCaching`'s own doc comment for what happens when one is omitted.
 *
 * A rejection never fails a request: the HTTP cache treats a failed `get` as a miss and skips a failed write or
 * eviction, reporting it to `CacheObserver.onError`.
 */
export interface Cache {
  /** An entry past its `ttl` reads as `undefined`. */
  get(key: string, segment?: string): Promise<CacheEntry | undefined>

  /**
   * `result[i]` is the entry for `keys[i]`: the result is as long as `keys`, duplicates included, and holds
   * `undefined` where a key is absent or past its `ttl`.
   */
  getMany(keys: string[], segment?: string): Promise<(CacheEntry | undefined)[]>

  /** @param ttl - Positive. One that is not stores nothing. */
  put(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void>

  /**
   * Writes every item into `segment`, each with its own `ttl`. An item whose `ttl` is not positive is left out.
   *
   * Not atomic: a rejection does not say which items were written.
   */
  putMany(items: CachePutItem[], segment?: string): Promise<void>

  delete(key: string, segment?: string): Promise<void>
  deleteMany(keys: string[], segment?: string): Promise<void>

  /**
   * Removes every entry of `segment`, or every entry of the store without one. A store may refuse the form
   * without a segment; the HTTP cache never uses it.
   */
  clear(segment?: string): Promise<void>
}
