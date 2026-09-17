import type { Duration } from '@caffeinejs/std'

export interface CacheEntry {
  payload: string | Buffer
  etag?: string
  lastModified?: string
  /** Epoch milliseconds when the entry was stored; used to compute the `Age` header and honor request `max-age`. */
  storedAt?: number
  headers: Record<string, string>
}

/**
 * Server-side store backing the cache feature.
 *
 * Implement it directly (`class RedisCache implements Cache`) and bind/pass the class as its own DI key:
 * `container.bind(RedisCache, t => t.toSelf())`, then `.store(RedisCache)`. A store must always be given
 * explicitly — see `HTTPCaching`'s own doc comment for what happens when one is omitted.
 */
export interface Cache {
  get(key: string, segment?: string): Promise<CacheEntry | undefined>
  set(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void>
  delete(key: string, segment?: string): Promise<void>
  deleteMany(keys: string[], segment?: string): Promise<void>
  clear(segment?: string): Promise<void>
}
