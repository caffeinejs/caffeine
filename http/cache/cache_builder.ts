import { $t, kServiceConfigure, type Service } from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigAccessors, type ConfigHandle } from '@caffeinejs/std/config'
import type { ServiceKit } from '../service.js'
import { ETagGenerator } from './cache.js'
import { CacheStore } from './store.js'
import { kCacheStatusHeader, kETagGenerator } from './keys.js'

/** The default location of the cache settings in the configuration tree. */
export const CACHE_CONFIG_NAMESPACE: readonly string[] = ['cache']

/** The cache feature's slice of the configuration tree. */
export interface CacheConfig {
  /** The cache-status response header name, carrying HIT/MISS/BYPASS. */
  statusHeader: string
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = { statusHeader: 'X-Cache' }

const cacheConfigSchema = $t.Object({
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
export class CacheBuilder<C = unknown> implements Service {
  #store: CacheStore | undefined
  #etagGenerator: ETagGenerator | undefined
  #statusHeader: string | undefined
  #selector?: (c: ConfigHandle<C>) => ConfigAccessors<CacheConfig>

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
  config(selector: (c: ConfigHandle<C>) => ConfigAccessors<CacheConfig>): this {
    this.#selector = selector
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (this.#store !== undefined) {
      kit.container.bind(CacheStore).toValue(this.#store).internal()
    }

    if (this.#etagGenerator !== undefined) {
      kit.container.bind(kETagGenerator).toValue(this.#etagGenerator).internal()
    }

    const slice = defineFeatureConfig<CacheConfig>(kit.config, {
      namespace: CACHE_CONFIG_NAMESPACE,
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: cacheConfigSchema,
      defaults: { ...DEFAULT_CACHE_CONFIG },
      values: { statusHeader: this.#statusHeader },
    })

    kit.container
      .bind(kCacheStatusHeader)
      // Lazy so the slice has published: `resolveCacheDeps` reads this once at start-up, after init.
      .toFactory(() => slice.config.statusHeader)
      .internal()

    return Promise.resolve()
  }
}
