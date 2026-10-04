import {
  kSelfRefresh,
  mod,
  Scopes,
  token,
  type InjectionToken,
  type Module,
  type Provider,
  type SelfRefreshable,
} from '@caffeinejs/di'

import { ConfigStore } from '../store.js'
import type { ConfigSnapshot } from '../types.js'

/** The label `refresher.refresh(CONFIG_REFRESH_LABEL)` takes to reload every live configuration source. */
export const CONFIG_REFRESH_LABEL: unique symbol = Symbol('@caffeinejs/config:refresh-label')

/**
 * Binds a loaded configuration into a container.
 *
 * - The snapshot current when the module runs under the definition's `configToken`. A reload never reaches it.
 * - A provider under the definition's `liveConfigToken`, whose `get()` answers the snapshot of the current revision.
 * - The store under the definition's `storeToken`, typed, and under the {@link ConfigStore} class, which is how the
 *   framework finds it.
 * - The same snapshot as the values, so `$i.config(c => c.database.host)` reads configuration as it was at
 *   start-up, and the same provider as the scoped config, so `$i.liveConfig(c => c.database.host)` reads it as it is
 *   now. Either is left alone when the application bound its own.
 * - A binding under `CONFIG_REFRESH_LABEL`, so `container.refresher.refresh(CONFIG_REFRESH_LABEL)` reloads the live
 *   sources. It rejects when the reload was rejected or a source that is not `optional` failed.
 *
 * The store closes with the container.
 */
export function ConfigModule<T>(store: ConfigStore<T>): Module {
  return mod('ConfigModule', container => {
    const { configToken, liveConfigToken, storeToken } = store.definition
    const snapshot: ConfigSnapshot<T> = store.current
    const live: Provider<ConfigSnapshot<T>> = { get: () => store.current }

    // `T` is the application's own read-only type, so a snapshot is exactly what the tokens name.
    container.bind(configToken, t => t.toValue(snapshot as T))
    container.bind(liveConfigToken, t => t.toValue(live as Provider<T>))
    container.bind(storeToken, t => t.toValue(store))
    container.bind(ConfigStore, t => t.toValue(store).internal())

    // An application that bound its own values, or its own scoped config, meant it.
    if (!container.hasValues) {
      container.bindConfig(snapshot)
    }
    if (!container.hasScopedConfig) {
      container.bindScopedConfig(live)
    }

    const refresher: SelfRefreshable = {
      async [kSelfRefresh]() {
        const outcome = await store.reload()
        if (outcome.status === 'rejected') {
          throw outcome.error
        }
        // An optional source is logged when it fails, and the refresh stands without it, as start-up does.
        const failure = outcome.failures.find(f => !f.optional)
        if (failure !== undefined) {
          throw failure.error
        }
      },
    }
    container.bind(token<SelfRefreshable>(Symbol('@caffeinejs/config:refresher')), t =>
      t
        .toValue(refresher)
        .lifetime(Scopes.REFRESH)
        .labels(CONFIG_REFRESH_LABEL as symbol),
    )

    container.hooks.on('onDisposed', async () => {
      await store.close()
    })
  })
}
