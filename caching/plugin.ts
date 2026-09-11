import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { CacheBuilder } from './builder.js'

/**
 * The `@caffeinejs/caching` application feature. `.extend(caching())` turns HTTP response caching on and
 * binds a default in-memory store; pass a callback to set the store, ETag generator, or status header.
 * Per-route behavior is the `@Cache` / `@CacheInvalidate` decorators or the `cache()` / `cacheInvalidate()`
 * route extensions. Install it after `.authentication(...)`.
 */
export function caching<C = unknown>(configure?: FeatureConfigurer<CacheBuilder<C>, C>): Feature<C> {
  return new CacheBuilder<C>(configure as never)
}
