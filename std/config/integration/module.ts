import { type Module, Scopes } from '@caffeinejs/di'
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
 * Given a {@link ConfigDefinition}, everything is read when the module runs — at `container.init()`, which is
 * after every `kServiceConfigure` has had its chance to register sources and slices. That ordering is what
 * makes a feature able to contribute to the tree it later reads from.
 */
export function ConfigModule<T>(options: ConfigModuleOptions<T> | ConfigDefinition): Module {
  let definition: ConfigDefinition | undefined
  let bootstrapOpts: BootstrapOptions<T>
  let token: symbol | string

  if (isDefinition(options)) {
    definition = options
    token = options.token
    bootstrapOpts = {
      sources: options.sources,
      // The definition is type-erased — its schema is whatever `.config()` declared, and `T` is recovered from
      // the caller that named it.
      schema: options.schema as ConfigSchema<T>,
      slices: options.slices,
      context: options.context,
      failFast: options.failFast,
      secrets: options.secrets,
      warn: message => options.warn?.(message),
    }
  } else {
    token = options.token
    bootstrapOpts = {
      sources: options.sources,
      providers: options.providers,
      schema: options.schema,
      slices: options.slices,
      context: options.context,
      failFast: options.failFast,
      secrets: options.secrets,
    }
  }

  return async container => {
    // Read at init: by now every feature has registered its sources and slices.
    if (definition !== undefined) {
      bootstrapOpts.schema = definition.schema as ConfigSchema<T>
      bootstrapOpts.context = definition.context
      bootstrapOpts.failFast = definition.failFast
      // Read here, not at construction: features register their slices — and their secrets — at
      // `kServiceConfigure`, which has only just finished running.
      bootstrapOpts.secrets = definition.secrets
    }

    const shard = await ConfigShard.bootstrap<T>(bootstrapOpts)
    definition?.markBootstrapped()

    const shardKey = Symbol('@caffeinejs/config:shard')

    container.bind<ConfigHandle<T>>(token as symbol).toValue(shard.handle)

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
