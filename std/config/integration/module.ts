import {
  Keys,
  kSelfRefresh,
  mod,
  Scopes,
  token,
  type InjectionToken,
  type Module,
  type SelfRefreshable,
} from '@caffeinejs/di'

import { ConfigStore } from '../store.js'

/** The label `refresher.refresh(CONFIG_REFRESH_LABEL)` takes to reload every live configuration source. */
export const CONFIG_REFRESH_LABEL: unique symbol = Symbol('@caffeinejs/config:refresh-label')

/**
 * Binds a loaded configuration into a container.
 *
 * - The live config object under the definition's key, and the store under its store key, when it names them.
 * - The store under the {@link ConfigStore} class, which is how the framework finds it.
 * - The current snapshot as the values provider, so `$i.value(c => c.database.host)` reads configuration. The value
 *   is read when the consumer is built.
 * - A binding under `CONFIG_REFRESH_LABEL`, so `container.refresher.refresh(CONFIG_REFRESH_LABEL)` reloads the live
 *   sources. It rejects when the reload was rejected or a source that is not `optional` failed.
 *
 * The store closes with the container.
 */
export function ConfigModule<T>(store: ConfigStore<T>): Module {
  return mod('ConfigModule', container => {
    const { key, storeKey } = store.definition

    if (key !== undefined) {
      // `T` is the application's own read-only type, so the live object is exactly what the key names.
      container.bind(key, t => t.toValue(store.live as T))
    }
    if (storeKey !== undefined) {
      container.bind(storeKey, t => t.toValue(store))
    }
    container.bind(ConfigStore as InjectionToken<ConfigStore<unknown>>, t =>
      t.toValue(store as ConfigStore<unknown>).internal(),
    )

    // An application that bound its own values provider meant it. A module is handed the binding operations only,
    // so the check walks the entries.
    const boundAlready = [...container.entries()].some(([bound]) => bound === Keys.kValuesProvider)
    if (!boundAlready) {
      // Transient, so every injection reads the snapshot that is current then.
      container.bindValuesProvider(t => t.toFactory(() => store.current).lifetime(Scopes.TRANSIENT))
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
