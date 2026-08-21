import type { AnySchema } from '../schema/schema.js'
import type { ConfigHandle } from './config_accessor.js'
import { createLiveAccessors } from './config_accessor.js'
import type { ConfigDiagnostics } from './config_diagnostics.js'
import { createConfigDiagnostics } from './config_diagnostics.js'
import { ConfigEngine } from './config_engine.js'
import { materialize } from './materializer.js'
import type { ConfigSchema, InferConfig } from './schema.js'
import { validateConfig } from './schema.js'
import type { ConfigProvider, ConfigSnapshot, ResolutionContext } from './types.js'

export interface BootstrapOptions<T> {
  providers: ConfigProvider[]
  schema: ConfigSchema<T>
  context?: ResolutionContext
  failFast?: boolean
}

export interface ConfigBootstrapResult<T> {
  config: ConfigHandle<T>
  diagnostics: ConfigDiagnostics
  validated: T
  snapshot: ConfigSnapshot
}

const DEFAULT_CONTEXT: ResolutionContext = { app: 'application', profiles: ['default'] }

/**
 * Resolves every provider, materializes the result, and validates it against the schema.
 *
 * The first overload infers the config type from the schema, which is what a direct caller wants — a `$t` schema
 * satisfies `ConfigSchema<T>` for any `T`, so `T` cannot be recovered from the parameter alone. The second serves
 * the internal path, where the config type is already known and threaded down from the application builder.
 */
export async function bootstrapConfig<S extends AnySchema>(
  options: { schema: S } & Omit<BootstrapOptions<never>, 'schema'>,
): Promise<ConfigBootstrapResult<InferConfig<S>>>
export async function bootstrapConfig<T>(options: BootstrapOptions<T>): Promise<ConfigBootstrapResult<T>>
export async function bootstrapConfig<T>(options: BootstrapOptions<T>): Promise<ConfigBootstrapResult<T>> {
  const ctx = options.context ?? { ...DEFAULT_CONTEXT, profiles: [...DEFAULT_CONTEXT.profiles] }
  const engine = new ConfigEngine({ providers: options.providers, failFast: options.failFast })

  const snapshot = await engine.resolve(ctx)
  const materialized = materialize(snapshot)
  const validated = validateConfig(options.schema, materialized)
  const config = createLiveAccessors(() => validated)
  const diagnostics = createConfigDiagnostics(validated, snapshot)

  return { config, diagnostics, validated, snapshot }
}
