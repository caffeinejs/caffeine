import { parseDuration, type Duration } from '@caffeinejs/std'
import { bytes, type ByteSize } from '@caffeinejs/std/bytes'
import { LRUCache } from 'lru-cache'

import type {
  HTTPCacheCallOptions,
  HTTPCacheEntry,
  HTTPCacheGetOptions,
  HTTPCachePutOptions,
  HTTPCacheStore,
} from '../../http/store.js'
import type { Cache, CacheEntry, CachePutItem } from '../../store.js'

export interface MemoryCacheOptions {
  /** Maximum number of entries kept in the cache. Defaults to 500. */
  max?: number
  /**
   * Optional cap on the total bytes of cached entries: `'512kb'`, `'10MB'`, or a bare number of bytes. When set,
   * the store evicts least-recently-used entries once the summed size of stored payloads (plus their headers)
   * exceeds this budget.
   */
  maxSize?: ByteSize
}

export class MemoryCache implements Cache {
  #cache: LRUCache<string, CacheEntry>

  /**
   * Takes either {@link MemoryCacheOptions}, or a pre-built `LRUCache` instance to use as-is — for eviction
   * settings `MemoryCacheOptions` doesn't expose (`ttlAutopurge`, a custom `dispose`, and the rest of
   * `lru-cache`'s own options).
   */
  constructor(options?: MemoryCacheOptions | LRUCache<string, CacheEntry>) {
    if (options instanceof LRUCache) {
      this.#cache = options
      return
    }

    this.#cache =
      options?.maxSize !== undefined
        ? new LRUCache({ max: options.max ?? 500, maxSize: bytes(options.maxSize), sizeCalculation: entrySize })
        : new LRUCache({ max: options?.max ?? 500 })
  }

  async get(key: string, segment?: string): Promise<CacheEntry | undefined> {
    return this.#cache.get(cacheKey(key, segment))
  }

  async getMany(keys: string[], segment?: string): Promise<(CacheEntry | undefined)[]> {
    const entries = new Array<CacheEntry | undefined>(keys.length)
    for (let i = 0; i < keys.length; i++) {
      entries[i] = this.#cache.get(cacheKey(keys[i], segment))
    }

    return entries
  }

  async put(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void> {
    this.#put(key, entry, ttl, segment)
  }

  async putMany(items: CachePutItem[], segment?: string): Promise<void> {
    for (const item of items) {
      this.#put(item.key, item.entry, item.ttl, segment)
    }
  }

  async delete(key: string, segment?: string): Promise<void> {
    this.#cache.delete(cacheKey(key, segment))
  }

  async deleteMany(keys: string[], segment?: string): Promise<void> {
    for (const key of keys) {
      this.#cache.delete(cacheKey(key, segment))
    }
  }

  async clear(segment?: string): Promise<void> {
    if (!segment) {
      this.#cache.clear()
      return
    }
    const prefix = segmentPrefix(segment)
    // Copied first: deleting from the cache while walking its own keys is nothing `lru-cache` promises to survive.
    for (const key of [...this.#cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.#cache.delete(key)
      }
    }
  }

  // `lru-cache` reads a ttl of 0 as "never expires", so a ttl that is not positive must not reach it.
  #put(key: string, entry: CacheEntry, ttl: Duration, segment?: string): void {
    const ms = parseDuration(ttl) * 1000
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    this.#cache.set(cacheKey(key, segment), entry, { ttl: ms })
  }
}

// Length-prefixed, so no segment is a prefix of another (`a` and `a:b`) and an unsegmented key cannot read as a
// segmented one (`users:1` against segment `users`, key `1`).
function segmentPrefix(segment: string): string {
  return `${segment.length}:${segment}`
}

function cacheKey(key: string, segment?: string): string {
  return segment ? `${segmentPrefix(segment)}${key}` : `0:${key}`
}

// Rough byte size of an entry: the payload plus its stored headers (etag/last-modified included).
function entrySize(entry: CacheEntry): number {
  const payloadBytes = typeof entry.payload === 'string' ? Buffer.byteLength(entry.payload) : entry.payload.length
  let headerBytes = 0
  for (const [k, v] of Object.entries(entry.headers)) {
    headerBytes += k.length
    if (typeof v === 'string') {
      headerBytes += v.length
    } else {
      for (const item of v) {
        headerBytes += item.length
      }
    }
  }

  return payloadBytes + headerBytes + (entry.etag?.length ?? 0) + (entry.lastModified?.length ?? 0) + 1
}

export interface MemoryHTTPCacheStoreOptions {
  /** Maximum number of entries kept. Defaults to 500. */
  max?: number
  /**
   * Optional cap on the total bytes of stored entries: `'512kb'`, `'10MB'`, or a bare number of bytes. When set,
   * the store evicts least-recently-used entries once the summed size of stored payloads (plus their headers)
   * exceeds this budget.
   */
  maxSize?: ByteSize
}

/** What {@link MemoryHTTPCacheStore} keeps under a key: the entry, and the generation of each tag it was stored under. */
export interface MemoryHTTPCacheRecord {
  entry: HTTPCacheEntry
  tags: Record<string, number>
}

/**
 * An {@link HTTPCacheStore} in this process, on an `lru-cache`.
 *
 * A tag is a generation counter: an entry records the generation of each of its tags when it is stored, and
 * reads as absent once any of them has moved on. `evictByTag` moves the counter and touches no entry; the entry
 * goes when it is next read, overwritten, or expired.
 */
export class MemoryHTTPCacheStore implements HTTPCacheStore {
  readonly #cache: LRUCache<string, MemoryHTTPCacheRecord>
  readonly #generations = new Map<string, number>()

  /**
   * Takes either {@link MemoryHTTPCacheStoreOptions}, or a pre-built `LRUCache` to use as-is — for eviction
   * settings the options do not expose (`ttlAutopurge`, a custom `dispose`, and the rest of `lru-cache`'s own).
   */
  constructor(options?: MemoryHTTPCacheStoreOptions | LRUCache<string, MemoryHTTPCacheRecord>) {
    if (options instanceof LRUCache) {
      this.#cache = options
      return
    }

    this.#cache =
      options?.maxSize !== undefined
        ? new LRUCache({ max: options.max ?? 500, maxSize: bytes(options.maxSize), sizeCalculation: recordSize })
        : new LRUCache({ max: options?.max ?? 500 })
  }

  // The tags hint is not needed: the generations are right here.
  async get(key: string, options?: HTTPCacheGetOptions): Promise<HTTPCacheEntry | undefined> {
    options?.signal?.throwIfAborted()

    const record = this.#cache.get(key)
    if (record === undefined) {
      return undefined
    }

    for (const tag in record.tags) {
      if (record.tags[tag] !== this.#generation(tag)) {
        this.#cache.delete(key)
        return undefined
      }
    }

    return record.entry
  }

  // `lru-cache` reads a ttl of 0 as "never expires", so a ttl that is not positive must not reach it.
  async put(key: string, entry: HTTPCacheEntry, options: HTTPCachePutOptions): Promise<void> {
    options.signal?.throwIfAborted()

    const ms = parseDuration(options.ttl) * 1000
    if (!(ms > 0) || !Number.isFinite(ms)) {
      return
    }

    const tags: Record<string, number> = {}
    for (const tag of options.tags ?? []) {
      tags[tag] = this.#generation(tag)
    }

    this.#cache.set(key, { entry, tags }, { ttl: ms })
  }

  async evictByTag(tags: string | readonly string[], options?: HTTPCacheCallOptions): Promise<void> {
    options?.signal?.throwIfAborted()

    for (const tag of typeof tags === 'string' ? [tags] : tags) {
      this.#generations.set(tag, this.#generation(tag) + 1)
    }
  }

  #generation(tag: string): number {
    return this.#generations.get(tag) ?? 0
  }
}

function recordSize(record: MemoryHTTPCacheRecord): number {
  let tagBytes = 0
  for (const tag in record.tags) {
    tagBytes += tag.length + 8
  }

  return entrySize(record.entry) + tagBytes
}
