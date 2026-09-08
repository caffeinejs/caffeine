import { Scopes } from '@caffeinejs/di'
import { type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { CacheStore, MemoryCacheStore } from './store.js'

export class CacheServiceConfigurer implements FeatureLifecycle {
  get name(): string {
    return 'cache'
  }

  bootstrap(kit: BootstrapKit): Promise<void> {
    if (!kit.container.has(CacheStore)) {
      kit.container.bind(CacheStore, t => t.toClass(MemoryCacheStore).lifetime(Scopes.SINGLETON).internal())
    }

    return Promise.resolve()
  }
}
