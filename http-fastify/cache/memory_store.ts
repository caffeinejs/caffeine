import { LRUCache } from 'lru-cache'
import { CacheEntry, CacheStore } from './types.js'

export interface MemoryCacheStoreOptions {
  max?: number
}

export class MemoryCacheStore implements CacheStore {
  #cache: LRUCache<string, CacheEntry>

  constructor(options?: MemoryCacheStoreOptions) {
    this.#cache = new LRUCache({ max: options?.max ?? 500 })
  }

  async get(key: string, segment: string): Promise<CacheEntry | undefined> {
    return this.#cache.get(`${segment}:${key}`)
  }

  async set(key: string, segment: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    this.#cache.set(`${segment}:${key}`, entry, { ttl: ttlSeconds * 1000 })
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
