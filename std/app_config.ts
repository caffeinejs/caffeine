import type { ConfigModuleOptions, ConfigProvider, ConfigSchema, ResolutionContext } from './config/index.js'

/**
 * The well-known token the base `.config()` builder binds the application {@link ConfigHandle} under.
 * Features resolve it to read their configuration slice (e.g. `.server(s => s.config(c => c.server))`).
 */
export const kAppConfig = Symbol.for('@caffeinejs/std:app.config')

/** Thrown when a feature is configured through both builder options and a config selector. */
export class ErrConfigSourceConflict extends Error {
  readonly code = 'ERR_CONFIG_SOURCE_CONFLICT'

  constructor(feature: string) {
    super(`Cannot configure feature "${feature}" via both builder options and config: choose one`)
    this.name = 'ErrConfigSourceConflict'
  }
}

/** Thrown when the application config definition declares no source. */
export class ErrIncompleteConfigDefinition extends Error {
  readonly code = 'ERR_INCOMPLETE_CONFIG_DEFINITION'

  constructor(missing: 'source') {
    super(`Cannot build application config: no ${missing} defined`)
    this.name = 'ErrIncompleteConfigDefinition'
  }
}

/**
 * Fluent definition of the application configuration sources, passed to
 * `.config(schema, c => c.source(...).context(...))`.
 *
 * The schema is supplied to `.config()` directly (not through this builder), so the application config type is
 * inferred from that argument regardless of the callback's shape — it may be a block body, a named function,
 * or omitted entirely. This builder only collects sources and the resolution context, producing the
 * {@link ConfigModuleOptions} the base builder feeds to `ConfigModule`, bound under {@link kAppConfig}.
 */
export class AppConfigBuilder<T = unknown> {
  readonly #schema: ConfigSchema<T>
  readonly #providers: ConfigProvider[] = []
  #context?: ResolutionContext

  constructor(schema: ConfigSchema<T>) {
    this.#schema = schema
  }

  /** Adds a single config source. Sources are consulted in registration order (first wins). */
  source(provider: ConfigProvider): this {
    this.#providers.push(provider)
    return this
  }

  /** Adds several config sources at once, in the given order (first wins). */
  sources(...providers: ConfigProvider[]): this {
    this.#providers.push(...providers)
    return this
  }

  /** Sets the resolution context (app name, profiles, label, ...). */
  context(context: ResolutionContext): this {
    this.#context = context
    return this
  }

  /** Materializes the {@link ConfigModuleOptions} for `ConfigModule`. Throws if no source was added. */
  toOptions(): ConfigModuleOptions<T> {
    if (this.#providers.length === 0) {
      throw new ErrIncompleteConfigDefinition('source')
    }

    return {
      token: kAppConfig,
      schema: this.#schema,
      providers: [...this.#providers],
      context: this.#context,
    }
  }
}
