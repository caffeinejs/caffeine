import { Scopes } from '@caffeinejs/di'
import { kBootstrap, kFeatureName, type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { CacheStore, MemoryCacheStore } from './store.js'

export class CacheServiceConfigurer implements FeatureLifecycle {
  get [kFeatureName](): string {
    return 'cache'
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    if (!kit.container.has(CacheStore)) {
      kit.container.bind(CacheStore, t => t.toClass(MemoryCacheStore).lifetime(Scopes.SINGLETON).internal())
    }

    return Promise.resolve()
  }
}
