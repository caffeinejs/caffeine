import { Scopes } from '@caffeinejs/di'
import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'

import { ETagGenerator } from './cache.js'
import { cacheConfigSchema, DEFAULT_CACHE_CONFIG, type CacheConfig } from './config.js'
import { CacheRouteContributor } from './contributor.js'
import { kCacheStatusHeader, kETagGenerator } from './keys.js'
import { CacheStore, MemoryCacheStore } from './store.js'

/**
 * Configures the cache feature: the {@link CacheStore} that backs cached responses and the
 * {@link ETagGenerator} used to hash payloads. Bound via `.extend(caching(), c => c.store(...).etagGenerator(...))`.
 *
 * Installing the feature is the activating act: the bootstrap binds the store, registers
 * {@link CacheRouteContributor} with the application's extensions, and the adapter runs it while it
 * registers routes. Configuration parameterizes the feature but never switches it on.
 *
 * `statusHeader` is read from the configuration tree at `cache.*`, so `CACHE__STATUS_HEADER=X-Edge-Cache`
 * overrides whatever the builder set. The store and the generator cannot be configuration — one is an
 * instance and the other a function — so they stay builder-only.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class CacheBuilder<C = unknown> extends FeatureBuilder<CacheConfig, C> {
  readonly [kFeatureName] = 'cache'

  protected readonly schema = cacheConfigSchema
  protected readonly defaults = { ...DEFAULT_CACHE_CONFIG }

  #store: CacheStore | undefined
  #etagGenerator: ETagGenerator | undefined

  store(store: CacheStore): this {
    this.#store = store
    return this
  }

  etagGenerator(generator: ETagGenerator): this {
    this.#etagGenerator = generator
    return this
  }

  /** Sets the cache-status response header name (default `X-Cache`), carrying HIT/MISS/BYPASS. */
  statusHeader(name: string): this {
    return this.set('statusHeader', name)
  }

  protected bootstrap(kit: BootstrapKit): void {
    const store = this.#store
    if (store !== undefined) {
      kit.container.bind(CacheStore, t => t.toValue(store).internal())
    } else if (!kit.container.has(CacheStore)) {
      // The default store, bound only when the feature is installed and nothing else bound one.
      kit.container.bind(CacheStore, t => t.toClass(MemoryCacheStore).lifetime(Scopes.SINGLETON).internal())
    }

    const etagGenerator = this.#etagGenerator
    if (etagGenerator !== undefined) {
      kit.container.bind(kETagGenerator, t => t.toValue(etagGenerator).internal())
    }

    kit.container.bind(kCacheStatusHeader, t =>
      t
        // Read through the slice rather than captured: `resolveCacheDeps` reads this once at start-up, but
        // a header name that followed a refresh is the behaviour every other config value has.
        .toFactory(() => this.slice.config.statusHeader)
        .internal(),
    )

    kit.extensions.register(CacheRouteContributor, new CacheRouteContributor())
  }
}
