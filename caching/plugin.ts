import { feature, type Feature } from '@caffeinejs/std'

import { CacheBuilder } from './builder.js'

/**
 * The `@caffeinejs/caching` application feature. `.extend(caching())` turns HTTP response caching on and
 * binds a default in-memory store; pass a callback to set the store, ETag generator, or status header.
 * Per-route behavior is the `@Cache` / `@CacheInvalidate` decorators or the `cache()` / `cacheInvalidate()`
 * route extensions. Install it after `.extend(authentication())`.
 */
export const caching = (): Feature<CacheBuilder> => feature('cache', () => new CacheBuilder())
