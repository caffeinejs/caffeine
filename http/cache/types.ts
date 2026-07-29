import { Duration } from '@caffeinejs/std'
import { FastifyContextRequest } from '../FastifyContextRequest.js'

export type ETagGenerator = (payload: Buffer) => string | Promise<string>

export interface CacheEntry {
  payload: string | Buffer
  etag?: string
  lastModified?: string
  headers: Record<string, string>
}

export interface CacheInvalidateOptions {
  paths?: string[]
  segment?: string
}

export interface CacheStore {
  get(key: string, segment: string): Promise<CacheEntry | undefined>
  set(key: string, segment: string, entry: CacheEntry, ttlSeconds: number): Promise<void>
  delete(key: string, segment: string): Promise<void>
  deleteMany(keys: string[], segment: string): Promise<void>
  clear(segment?: string): Promise<void>
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
