import { Scopes } from '@caffeinejs/di'
import { type Service } from '@caffeinejs/std'
import type { ServiceKit } from '../service.js'
import { CacheStore, MemoryCacheStore } from './store.js'

export class CacheServiceConfigurer implements Service {
  get name(): string {
    return 'cache'
  }

  bootstrap(kit: ServiceKit): Promise<void> {
    if (!kit.container.has(CacheStore)) {
      kit.container.bind(CacheStore)
        .toClass(MemoryCacheStore)
        .lifetime(Scopes.SINGLETON)
        .internal()
    }

    return Promise.resolve()
  }
}
