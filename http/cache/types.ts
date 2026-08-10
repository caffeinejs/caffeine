import { Duration } from '@caffeinejs/std'
import { FastifyContextRequest } from '../context.js'

export type ETagGenerator = (payload: Buffer) => string | Promise<string>

export interface CacheEntry {
  payload: string | Buffer
  etag?: string
  lastModified?: string
  /** Epoch milliseconds when the entry was stored; used to compute the `Age` header and honor request `max-age`. */
  storedAt?: number
  headers: Record<string, string>
}

export interface CacheInvalidateOptions {
  paths?: string[]
  segment?: string
}

/**
 * Server-side store backing the cache feature.
 *
 * Abstract class rather than an interface so it is a runtime value: it doubles as the DI token and the
 * base class. Bind a concrete store (`bind(CacheStore).toClass(RedisStore)` or
 * `bind(RedisStore).toSelf().extends(CacheStore)`), like `RefreshTokenStore` / `OpaqueTokenStore` /
 * `RememberMeTokenStore`. When no binding is registered, {@link MemoryCacheStore} resolves as a
 * fallback.
 */
export abstract class CacheStore {
  abstract get(key: string, segment: string): Promise<CacheEntry | undefined>
  abstract set(key: string, segment: string, entry: CacheEntry, ttlSeconds: number): Promise<void>
  abstract delete(key: string, segment: string): Promise<void>
  abstract deleteMany(keys: string[], segment: string): Promise<void>
  abstract clear(segment?: string): Promise<void>
}

export interface CacheOptions {
  ttl?: Duration
  sharedMaxAge?: Duration
  staleWhileRevalidate?: Duration
  staleIfError?: Duration
  noStore?: boolean
  noCache?: boolean
  mustRevalidate?: boolean
  proxyRevalidate?: boolean
  noTransform?: boolean
  privacy?: 'private' | 'public'
  immutable?: boolean
  vary?: string[]
  etag?: boolean
  methods?: string[]
  statusCodes?: number[]
  segment?: string
  key?: (req: FastifyContextRequest) => string
  etagGenerator?: ETagGenerator
}
