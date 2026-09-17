import { parseDuration, type Duration } from '@caffeinejs/std'
import { LRUCache } from 'lru-cache'

import { CacheStore, type CacheEntry } from '../../store.js'

export interface MemoryCacheStoreOptions {
  /** Maximum number of entries kept in the cache. Defaults to 500. */
  max?: number
  /**
   * Optional cap on the total bytes of cached entries. When set, the store evicts least-recently-used
   * entries once the summed size of stored payloads (plus their headers) exceeds this budget — a more
   * predictable bound on memory use than the entry count alone.
   */
  maxBytes?: number
}

export class MemoryCacheStore extends CacheStore {
  #cache: LRUCache<string, CacheEntry>

  constructor(options?: MemoryCacheStoreOptions) {
    super()
    this.#cache =
      options?.maxBytes !== undefined
        ? new LRUCache({ max: options.max ?? 500, maxSize: options.maxBytes, sizeCalculation: entrySize })
        : new LRUCache({ max: options?.max ?? 500 })
  }

  async get(key: string, segment: string): Promise<CacheEntry | undefined> {
    return this.#cache.get(`${segment}:${key}`)
  }

  async set(key: string, segment: string, entry: CacheEntry, ttl: Duration): Promise<void> {
    this.#cache.set(`${segment}:${key}`, entry, { ttl: parseDuration(ttl) * 1000 })
  }

  async delete(key: string, segment: string): Promise<void> {
    this.#cache.delete(`${segment}:${key}`)
  }

  async deleteMany(keys: string[], segment: string): Promise<void> {
    for (const key of keys) {
      this.#cache.delete(`${segment}:${key}`)
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

// Rough byte size of an entry: the payload plus its stored headers (etag/last-modified included).
function entrySize(entry: CacheEntry): number {
  const payloadBytes = typeof entry.payload === 'string' ? Buffer.byteLength(entry.payload) : entry.payload.length
  let headerBytes = 0
  for (const [k, v] of Object.entries(entry.headers)) {
    headerBytes += k.length + v.length
  }

  return payloadBytes + headerBytes + (entry.etag?.length ?? 0) + (entry.lastModified?.length ?? 0) + 1
}
