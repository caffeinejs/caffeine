export type { CacheEntry, ETagGenerator } from './cache.js'
export { attachCacheHooks, type CacheDeps, type CacheOptions, resolveCacheDeps } from './cache.js'
export { CacheBuilder, type CacheConfig, CACHE_CONFIG_NAMESPACE, DEFAULT_CACHE_CONFIG } from './cache_builder.js'
// CacheInvalidateOptions reaches the barrel through decorators/index.js; re-exporting it here too
// would be a duplicate export.
export { attachCacheInvalidateHook } from './cache_invalidate.js'
export { CacheServiceConfigurer } from './cache_service_configurer.js'
export { kETagGenerator } from './keys.js'
export { CacheStore } from './store.js'
export { MemoryCacheStore, type MemoryCacheStoreOptions } from './store.js'
