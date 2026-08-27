import { Keys, type Module, Scopes } from '@caffeinejs/di'
import type { BootstrapOptions } from '../bootstrap.js'
import type { ConfigHandle } from '../accessor.js'
import type { ConfigDefinition } from '../definition.js'
import type { ConfigSliceSpec } from '../slice.js'
import type { ConfigSources } from '../sources.js'
import { Configuration, kConfiguration } from '../configuration.js'
import type { ConfigSchema } from '../schema.js'
import type { ConfigProvider, ResolutionContext } from '../types.js'
import { ConfigShard } from './shard.js'

export const CONFIG_REFRESH_LABEL: unique symbol = Symbol('@caffeinejs/config:refresh-label')

export interface ConfigModuleOptions<T> {
  token: symbol | string
  schema: ConfigSchema<T>
  /** The live source registry. Preferred — late registrations are picked up because it is read at init. */
  sources?: ConfigSources
  /** Convenience for a fixed set of sources. */
  providers?: ConfigProvider[]
  slices?: readonly ConfigSliceSpec[]
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
  const token = options.token

  // A definition resolves itself, so the fields it holds are read when *it* bootstraps rather than captured
  // here. Only the options-object form needs its arguments assembled up front.
  const bootstrapOpts: BootstrapOptions<T> | undefined = definition !== undefined
    ? undefined
    : {
        sources: (options as ConfigModuleOptions<T>).sources,
        providers: (options as ConfigModuleOptions<T>).providers,
        schema: (options as ConfigModuleOptions<T>).schema,
        slices: (options as ConfigModuleOptions<T>).slices,
        context: (options as ConfigModuleOptions<T>).context,
        failFast: (options as ConfigModuleOptions<T>).failFast,
        secrets: (options as ConfigModuleOptions<T>).secrets,
      }

  return async container => {
    // Idempotent, so the usual path — the application bootstrapped between the two service steps — hands back
    // the shard it already built rather than resolving a second time.
    const shard = definition !== undefined
      ? await definition.bootstrap() as ConfigShard<T>
      : await ConfigShard.bootstrap<T>(bootstrapOpts!)

    const shardKey = Symbol('@caffeinejs/config:shard')

    container.bind<ConfigHandle<T>>(token as symbol).toValue(shard.handle)

    // The same handle, under the container's well-known values key, so `$i.value(c => c.database.host)` reads
    // the application configuration. The handle is live and the config resolver calls the binding's factory on
    // every read, so an injected value follows a refresh rather than freezing at construction.
    //
    // Guarded: an application that bound its own values provider meant it, and silently replacing it would be
    // the kind of framework surprise that is very hard to find. Checked by walking the entries because a module
    // is handed the binding operations only — `has()` is not among them.
    const boundAlready = [...container.entries()].some(([key]) => key === Keys.kValuesProvider)

    if (!boundAlready) {
      container.bindValuesProvider<ConfigHandle<T>>().toValue(shard.handle)
    }

    container
      .bind<Configuration<T>>(kConfiguration)
      .toValue(new Configuration<T>({
        get handle() {
          return shard.handle
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
      }))
      .internal()

    container
      .bind(shardKey)
      .toValue(shard)
      .lifetime(Scopes.REFRESH)
      .labels(CONFIG_REFRESH_LABEL as symbol)

    container.hooks.on('onDisposed', async () => {
      await shard.dispose()
    })
  }
}

function isDefinition<T>(options: ConfigModuleOptions<T> | ConfigDefinition): options is ConfigDefinition {
  return typeof (options as ConfigDefinition).slice === 'function'
}
