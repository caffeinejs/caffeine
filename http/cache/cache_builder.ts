import {
  $t,
  kBeforeBootstrap,
  kBootstrap,
  kFeatureName,
  type BeforeBootstrapKit,
  type BootstrapKit,
  type FeatureLifecycle,
} from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigLocation, type ConfigHandle, type ConfigSlice } from '@caffeinejs/std/config'

import { ETagGenerator } from './cache.js'
import { kCacheStatusHeader, kETagGenerator } from './keys.js'
import { CacheStore } from './store.js'

/** The cache feature's slice of the configuration tree. */
export interface CacheConfig {
  /** The cache-status response header name, carrying HIT/MISS/BYPASS. */
  statusHeader: string
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = { statusHeader: 'X-Cache' }

/**
 * The shape the cache expects wherever the application decides to keep its settings. Import it into an
 * application schema and point the builder at it with `c.config(c => c.app.cache)`.
 */
export const cacheConfigSchema = $t.Object({
  statusHeader: $t.String({ default: DEFAULT_CACHE_CONFIG.statusHeader }),
})

/**
 * Configures the cache feature: the {@link CacheStore} that backs cached responses and the
 * {@link ETagGenerator} used to hash payloads. Bound via `app.cache(c => c.store(...).etagGenerator(...))`.
 *
 * The recommended way to supply a custom store; a raw `container.bind(CacheStore)` also works. When no
 * store is set here, the always-on default `MemoryCacheStore` applies (see `CacheServiceConfigurer`).
 *
 * `statusHeader` is read from the configuration tree at `cache.*`, so `CACHE__STATUS_HEADER=X-Edge-Cache`
 * overrides whatever the builder set. The store and the generator cannot be configuration — one is an
 * instance and the other a function — so they stay builder-only.
 *
 * There is no `enabled` flag: reaching `app.cache(...)` is what switches the feature on, and a configuration
 * value that could switch it on instead would make a config file able to start a feature nobody asked for.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class CacheBuilder<C = unknown> implements FeatureLifecycle {
  readonly [kFeatureName] = 'cache'

  #store: CacheStore | undefined
  #etagGenerator: ETagGenerator | undefined
  #statusHeader: string | undefined
  #selector?: (c: ConfigHandle<C>) => ConfigLocation<CacheConfig>
  #resolved: ConfigSlice<CacheConfig> | undefined

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
    this.#statusHeader = name
    return this
  }

  /**
   * Places the cache settings elsewhere in the configuration tree, e.g. `c.config(x => x.app.cache)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigLocation<CacheConfig>): this {
    this.#selector = selector
    return this
  }

  [kBeforeBootstrap](kit: BeforeBootstrapKit): void {
    this.#resolved = defineFeatureConfig<CacheConfig>(kit.config, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: cacheConfigSchema,
      defaults: { ...DEFAULT_CACHE_CONFIG },
      values: { statusHeader: this.#statusHeader },
    })
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    const store = this.#store
    if (store !== undefined) {
      kit.container.bind(CacheStore, t => t.toValue(store).internal())
    }

    const etagGenerator = this.#etagGenerator
    if (etagGenerator !== undefined) {
      kit.container.bind(kETagGenerator, t => t.toValue(etagGenerator).internal())
    }

    kit.container.bind(kCacheStatusHeader, t =>
      t
        // Read through the slice rather than captured: `resolveCacheDeps` reads this once at start-up, but
        // a header name that followed a refresh is the behaviour every other config value has.
        .toFactory(() => this.#resolved!.config.statusHeader)
        .internal(),
    )

    return Promise.resolve()
  }
}
