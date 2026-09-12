import { Scopes } from '@caffeinejs/di'
import { registerPlugin } from '@caffeinejs/http'
import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import type { ConfigLocation } from '@caffeinejs/std/config'

import { ETagGenerator } from './cache.js'
import { cachePlugin } from './cache_plugin.js'
import { DEFAULT_CACHE_CONFIG, type CacheConfig } from './config.js'
import { kCacheStatusHeader, kETagGenerator } from './keys.js'
import { CacheStore, MemoryCacheStore } from './store.js'

/**
 * Configures the cache feature: the {@link CacheStore} that backs cached responses and the
 * {@link ETagGenerator} used to hash payloads. Bound via `.extend(caching(c => c.store(...).etagGenerator(...)))`.
 *
 * Installing the feature is the activating act: the bootstrap binds the store and contributes the cache
 * plugin, which attaches the hooks from an `onRoute` hook as each route registers. Configuration
 * parameterizes the feature but never switches it on.
 *
 * The store and the generator cannot come from configuration — one is an instance, the other a function.
 * `statusHeader` can, read from a node the callback hands over:
 *
 * ```ts
 * .extend(caching((cache, c) => cache.withConfig(c.app.cache)))
 * ```
 */
export class CacheBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'cache'

  #config: ConfigLocation<CacheConfig> | undefined
  #statusHeader: string | undefined
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

  /**
   * Reads the settings from a node of the configuration tree, e.g. `c.app.cache`.
   *
   * The node is read at bootstrap and the header name is snapshotted then: a refresh does not rename the
   * header a running cache already emits. {@link statusHeader} wins over what the node carries.
   */
  withConfig(config: ConfigLocation<CacheConfig>): this {
    this.#config = config
    return this
  }

  /** Sets the cache-status response header name (default `X-Cache`), carrying HIT/MISS/BYPASS. */
  statusHeader(name: string): this {
    this.#statusHeader = name
    return this
  }

  protected bootstrap(kit: BootstrapKit<C>): void {
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
        // Snapshotted at bootstrap: `resolveCacheDeps` reads this once at plugin setup into a string the
        // hooks close over, so a later refresh cannot rename the header a running cache already emits.
        .toValue(this.#statusHeader ?? this.#config?.statusHeader ?? DEFAULT_CACHE_CONFIG.statusHeader)
        .internal(),
    )

    registerPlugin(kit, cachePlugin())
  }
}
