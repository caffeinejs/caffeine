import type { Duration } from '@caffeinejs/std'

/** What the HTTP cache keeps of a response, and replays on a hit. */
export interface HTTPCacheEntry {
  payload: string | Buffer
  /** Status code of the stored response, replayed as is on a hit. */
  statusCode: number
  etag?: string
  lastModified?: string
  /** Epoch milliseconds when the entry was stored; the `Age` header and every freshness decision read it. */
  storedAt?: number
  headers: Record<string, string | string[]>
}

export interface HTTPCacheCallOptions {
  /**
   * Aborted, the call stops what it can and rejects. A store that cannot stop the work it started may ignore
   * it, except that a call made with a signal already aborted rejects without doing anything.
   */
  signal?: AbortSignal
}

export interface HTTPCacheGetOptions extends HTTPCacheCallOptions {
  /**
   * The tags the entry is expected to carry: a hint, so a store that keeps tags apart from entries can read
   * both in one go. The answer is the same with or without it.
   */
  tags?: readonly string[]
}

export interface HTTPCachePutOptions extends HTTPCacheCallOptions {
  /** How long the entry is kept. One that is not positive stores nothing. */
  ttl: Duration
  /** The tags {@link HTTPCacheStore.evictByTag} reaches the entry by. */
  tags?: readonly string[]
}

/**
 * The store behind the HTTP cache.
 *
 * Pass an instance to `HTTPCaching`, or bind one under {@link kHTTPCacheStore} and pass the token — then any
 * service can inject the store and evict by tag itself.
 *
 * A rejection never fails a request: the HTTP cache treats a failed `get` as a miss and skips a failed `put` or
 * eviction, reporting it to `CacheObserver.onError`.
 */
export interface HTTPCacheStore {
  /** `undefined` for a key that is absent, past its `ttl`, or carrying a tag evicted since it was stored. */
  get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined>

  put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void>

  /** Hides every entry stored with any of `tags`. A tag nothing was stored under is not an error. */
  evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void>
}
