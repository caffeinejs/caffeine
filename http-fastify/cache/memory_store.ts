import { CacheEntry, CacheStore } from './types.js'

export class MemoryCacheStore implements CacheStore {
  #entries = new Map<string, { entry: CacheEntry, expiresAt: number, segment: string }>()

  async get(key: string, segment: string): Promise<CacheEntry | undefined> {
    const item = this.#entries.get(`${segment}:${key}`)
    if (!item) {
      return undefined
    }

    if (Date.now() > item.expiresAt) {
      this.#entries.delete(`${segment}:${key}`)
      return undefined
    }

    return item.entry
  }

  async set(key: string, segment: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    this.#entries.set(`${segment}:${key}`, { entry, expiresAt: Date.now() + ttlSeconds * 1000, segment })
  }

  async delete(key: string, segment: string): Promise<void> {
    this.#entries.delete(`${segment}:${key}`)
  }

  async deleteMany(keys: string[], segment: string): Promise<void> {
    for (const key of keys) {
      this.#entries.delete(`${segment}:${key}`)
    }
  }

  async clear(segment?: string): Promise<void> {
    if (!segment) {
      this.#entries.clear()
      return
    }
    for (const [k, v] of this.#entries) {
      if (v.segment === segment) {
        this.#entries.delete(k)
      }
    }
  }
}
