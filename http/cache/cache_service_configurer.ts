import { Scopes } from '@caffeinejs/di'
import { type Service, type ServiceBootstrapIn } from '@caffeinejs/std'

import { CacheStore, MemoryCacheStore } from './store.js'

export class CacheServiceConfigurer implements Service {
  get name(): string {
    return 'cache'
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    if (!kit.container.has(CacheStore)) {
      kit.container.bind(CacheStore, t => t.toClass(MemoryCacheStore).lifetime(Scopes.SINGLETON).internal())
    }

    return Promise.resolve()
  }
}
