import { parseDuration, type Duration } from '@caffeinejs/std'
import { bytes, type ByteSize } from '@caffeinejs/std/bytes'
import { LRUCache } from 'lru-cache'

import type { Cache, CacheEntry } from '../../store.js'

export interface MemoryCacheOptions {
  /** Maximum number of entries kept in the cache. Defaults to 500. */
  max?: number
  /**
   * Optional cap on the total bytes of cached entries, written the way a Docker Compose file writes one
   * (`'512kb'`, `'10MB'`, or a bare number of bytes). When set, the store evicts least-recently-used
   * entries once the summed size of stored payloads (plus their headers) exceeds this budget — a more
   * predictable bound on memory use than the entry count alone.
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

  async set(key: string, entry: CacheEntry, ttl: Duration, segment?: string): Promise<void> {
    this.#cache.set(cacheKey(key, segment), entry, { ttl: parseDuration(ttl) * 1000 })
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
    const prefix = `${segment}:`
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) {
        this.#cache.delete(key)
      }
    }
  }
}

function cacheKey(key: string, segment?: string): string {
  return segment ? `${segment}:${key}` : key
}

// Rough byte size of an entry: the payload plus its stored headers (etag/last-modified included).
function entrySize(entry: CacheEntry): number {
  const payloadBytes = typeof entry.payload === 'string' ? Buffer.byteLength(entry.payload) : entry.payload.length
  let headerBytes = 0
  for (const [k, v] of Object.entries(entry.headers)) {
    headerBytes += k.length + v.length
  }

  return payloadBytes + headerBytes + (entry.etag?.length ?? 0) + (entry.lastModified?.length ?? 0) + 1
}
