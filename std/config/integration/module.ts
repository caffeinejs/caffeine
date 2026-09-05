import { Keys, mod, token, type Module, type NamedToken, Scopes, type InjectionToken } from '@caffeinejs/di'

import type { ConfigHandle } from '../accessor.js'
import type { BootstrapOptions } from '../bootstrap.js'
import { Configuration } from '../configuration.js'
import type { ConfigDefinition } from '../definition.js'
import type { ConfigSchema } from '../schema.js'
import type { ConfigSlice, ConfigSliceSpec } from '../slice.js'
import type { ConfigSources } from '../sources.js'
import type { ConfigProvider, ResolutionContext } from '../types.js'
import { ConfigShard } from './shard.js'

export const CONFIG_REFRESH_LABEL: unique symbol = Symbol('@caffeinejs/config:refresh-label')

export interface ConfigModuleOptions<T> {
  /** Where the configuration handle is bound. Omitted, the handle is reachable through value injection only. */
  token?: NamedToken<ConfigHandle<T>>
  schema: ConfigSchema<T>
  /** The live source registry. Preferred — late registrations are picked up because it is read at init. */
  sources?: ConfigSources
  /** Convenience for a fixed set of sources. */
  providers?: ConfigProvider[]
  slices?: readonly ConfigSliceSpec[]
  /** The slices published under a feature key, which the resolved handle answers a key with. */
  features?: ReadonlyMap<symbol, ConfigSlice<unknown>>
  context?: ResolutionContext
  failFast?: boolean
  /** Paths the diagnostics must redact, on top of whatever the root schema marks with `$t.Secret`. */
  secrets?: ReadonlySet<string>
}

/**
 * Binds an application's configuration.
 *
 * Given a {@link ConfigDefinition}, the resolved configuration is normally already there: the application
 * calls `definition.bootstrap()` between the two service steps, so every feature could read its own settings
 * while it was binding. This module then only binds what that produced.
 *
 * A definition that was never bootstrapped is resolved here instead, at `container.init()`. That is the
 * standalone path — a container assembled by hand, with no application driving the lifecycle — and it is why
 * the module owns the bindings rather than the application.
 */
export function ConfigModule<T>(options: ConfigModuleOptions<T> | ConfigDefinition): Module {
  const definition = isDefinition(options) ? options : undefined

  // A definition resolves itself, so the fields it holds are read when *it* bootstraps rather than captured
  // here. Only the options-object form needs its arguments assembled up front.
  const bootstrapOpts: BootstrapOptions<T> | undefined =
    definition !== undefined
      ? undefined
      : {
          sources: (options as ConfigModuleOptions<T>).sources,
          providers: (options as ConfigModuleOptions<T>).providers,
          schema: (options as ConfigModuleOptions<T>).schema,
          slices: (options as ConfigModuleOptions<T>).slices,
          features: (options as ConfigModuleOptions<T>).features,
          context: (options as ConfigModuleOptions<T>).context,
          failFast: (options as ConfigModuleOptions<T>).failFast,
          secrets: (options as ConfigModuleOptions<T>).secrets,
        }

  return mod('ConfigModule', async container => {
    // Idempotent, so the usual path — the application bootstrapped between the two service steps — hands back
    // the shard it already built rather than resolving a second time.
    const shard =
      definition !== undefined
        ? ((await definition.bootstrap()) as ConfigShard<T>)
        : await ConfigShard.bootstrap<T>(bootstrapOpts!)

    const shardKey = token<ConfigShard<T>>(Symbol('@caffeinejs/config:shard'))

    // Read here, not when the module was created: the application builder installs this module in its own
    // constructor and the key arrives later, with `.config(schema, key)`.
    const tokenName = definition !== undefined ? definition.token : (options as ConfigModuleOptions<T>).token

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
      t
        .toValue(
          new Configuration<T>({
            get handle() {
              return shard.handle
            },
            get snapshotHandle() {
              return shard.snapshotHandle
            },
            get validated() {
              return shard.validated
            },
            get revision() {
              return shard.revision
            },
            get diagnostics() {
              return shard.diagnostics
            },
            onChange: listener => shard.onChange(listener),
            settled: () => shard.settled(),
          }),
        )
        .internal(),
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

function isDefinition<T>(options: ConfigModuleOptions<T> | ConfigDefinition): options is ConfigDefinition {
  return typeof (options as ConfigDefinition).slice === 'function'
}
