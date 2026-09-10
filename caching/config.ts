import { $t } from '@caffeinejs/std'

/** The cache feature's slice of the configuration tree. */
export interface CacheConfig {
  /** The cache-status response header name, carrying HIT/MISS/BYPASS. */
  statusHeader: string
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = { statusHeader: 'X-Cache' }

/**
 * The shape the cache expects wherever the application decides to keep its settings. Import it into an
 * application schema and point the builder at it with `.config(c => c.app.cache)`.
 */
export const cacheConfigSchema = $t.Object({
  statusHeader: $t.String({ default: DEFAULT_CACHE_CONFIG.statusHeader }),
})
