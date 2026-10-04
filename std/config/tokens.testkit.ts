import type { NamedToken, Provider } from '@caffeinejs/di'

import type { ConfigStore } from './store.js'

/** The tokens a definition carries, fresh per call, for a test that builds its definition by hand. */
export function testTokens<T = never>(): {
  configToken: NamedToken<T>
  liveConfigToken: NamedToken<Provider<T>>
  storeToken: NamedToken<ConfigStore<T>>
} {
  return {
    configToken: Symbol('test.config') as NamedToken<T>,
    liveConfigToken: Symbol('test.config.live') as NamedToken<Provider<T>>,
    storeToken: Symbol('test.config.store') as NamedToken<ConfigStore<T>>,
  }
}
