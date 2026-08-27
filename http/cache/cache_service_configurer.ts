import { Scopes } from '@caffeinejs/di'
import { kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ServiceKit } from '../service.js'
import { CacheStore, MemoryCacheStore } from './store.js'

/**
 * Binds the default in-process {@link MemoryCacheStore} when no other {@link CacheStore} is configured,
 * so caching works out of the box. Always registered (like `ErrorHandlingServiceConfigurer`), after the
 * `CacheBuilder`, so a builder- or user-supplied store takes precedence.
 *
 * The `has()` guard cannot see a `.extends(CacheStore)` polymorphic binding (same limitation the auth
 * stores document), so registering a store *only* via `.extends(CacheStore)` is not supported — bind it
 * through `app.cache(c => c.store(...))` or a direct `container.bind(CacheStore)`.
 */
export class CacheServiceConfigurer implements Service {
  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (!kit.container.has(CacheStore)) {
      kit.container.bind(CacheStore)
        .toClass(MemoryCacheStore)
        .lifetime(Scopes.SINGLETON)
        .internal()
    }

    return Promise.resolve()
  }
}
