import { Keys, mod, token, type Module, type NamedToken, Scopes, type InjectionToken } from '@caffeinejs/di'

import type { ConfigHandle } from '../config.js'
import { Configuration } from '../configuration.js'
import type { ConfigDefinition } from '../definition.js'
import { ConfigShard } from './shard.js'

export const CONFIG_REFRESH_LABEL: unique symbol = Symbol('@caffeinejs/config:refresh-label')

/**
 * Binds an application's configuration.
 *
 * The resolved configuration is normally already there: the application calls `definition.bootstrap()` between
 * the two service steps, so every feature could read its own settings while it was binding. This module then
 * only binds what that produced.
 *
 * A definition that was never bootstrapped is resolved here instead, at `container.init()`. That is the
 * standalone path — a container assembled by hand, with no application driving the lifecycle — and it is why
 * the module owns the bindings rather than the application.
 */
export function ConfigModule<T>(definition: ConfigDefinition): Module {
  return mod('ConfigModule', async container => {
    // Idempotent, so the usual path — the application bootstrapped between the two service steps — hands back
    // the shard it already built rather than resolving a second time. The definition reads the fields it holds
    // when *it* bootstraps, so nothing is captured here.
    const shard = (await definition.bootstrap()) as ConfigShard<T>

    const shardKey = token<ConfigShard<T>>(Symbol('@caffeinejs/config:shard'))

    // Read here, not when the module was created: the application installs this module in its own constructor,
    // and the key arrives on the `config` option — built separately with `newConfiguration(schema, key)`.
    const tokenName = definition.token as NamedToken<ConfigHandle<T>> | undefined

    // Only when the application named a key. An application that declared no configuration of its own still has
    // its slices published and its values injectable; what it does not have is a root binding to reach them by.
    if (tokenName !== undefined) {
      container.bind(tokenName, t => t.toValue(shard.handle))
    }

    // The same handle, under the container's well-known values key, so `$i.value(c => c.database.host)` reads
    // the application configuration. The handle is live and the config resolver calls the binding's factory on
    // every read, so an injected value follows a refresh rather than freezing at construction.
    //
    // Guarded: an application that bound its own values provider meant it, and silently replacing it would be
    // the kind of framework surprise that is very hard to find. Checked by walking the entries because a module
    // is handed the binding operations only — `has()` is not among them.
    const boundAlready = [...container.entries()].some(([key]) => key === Keys.kValuesProvider)

    if (!boundAlready) {
      container.bindValuesProvider<ConfigHandle<T>>(t => t.toValue(shard.handle))
    }

    // Bound under the class, which cannot carry the application's config type: `get(Configuration)` hands back a
    // `Configuration<unknown>`, so the cast is what lets the one place that knows `T` construct the real wrapper.
    // The typed way to the same values is the application's own config key.
    container.bind(Configuration as InjectionToken<Configuration<unknown>>, t =>
      t.toValue(new Configuration<T>(shard)).internal(),
    )

    container.bind(shardKey, t =>
      t
        .toValue(shard)
        .lifetime(Scopes.REFRESH)
        .labels(CONFIG_REFRESH_LABEL as symbol),
    )

    container.hooks.on('onDisposed', async () => {
      await shard.dispose()
    })
  })
}
