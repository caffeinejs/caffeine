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
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the
 * base class. Bind a concrete store (`bind(CacheStore).toClass(RedisStore)` or
 * `bind(RedisStore).toSelf().extends(CacheStore)`). When no binding is registered, `MemoryCacheStore`
 * (`@caffeinejs/caching/store/memory`) resolves as a fallback.
 */
export abstract class CacheStore {
  abstract get(key: string, segment: string): Promise<CacheEntry | undefined>
  abstract set(key: string, segment: string, entry: CacheEntry, ttl: Duration): Promise<void>
  abstract delete(key: string, segment: string): Promise<void>
  abstract deleteMany(keys: string[], segment: string): Promise<void>
  abstract clear(segment?: string): Promise<void>
}
