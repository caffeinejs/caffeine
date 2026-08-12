import { kServiceConfigure, Service, ServiceKit } from '../service.js'
import { ETagGenerator } from './cache.js'
import { CacheStore } from './store.js'
import { kCacheStatusHeader, kETagGenerator } from './keys.js'

/**
 * Configures the cache feature: the {@link CacheStore} that backs cached responses and the
 * {@link ETagGenerator} used to hash payloads. Bound via `app.cache(c => c.store(...).etagGenerator(...))`.
 *
 * The recommended way to supply a custom store; a raw `container.bind(CacheStore)` also works. When no
 * store is set here, the always-on default {@link MemoryCacheStore} applies (see `CacheServiceConfigurer`).
 */
export class CacheBuilder implements Service {
  #store: CacheStore | undefined
  #etagGenerator: ETagGenerator | undefined
  #statusHeader: string | undefined

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

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (this.#store !== undefined) {
      kit.container.bind(CacheStore).toValue(this.#store).internal()
    }

    if (this.#etagGenerator !== undefined) {
      kit.container.bind(kETagGenerator).toValue(this.#etagGenerator).internal()
    }

    if (this.#statusHeader !== undefined) {
      kit.container.bind(kCacheStatusHeader).toValue(this.#statusHeader).internal()
    }

    return Promise.resolve()
  }
}
