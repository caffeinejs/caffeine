import { $t, FeatureBuilder, kFeatureName, type FeatureConfigureKit } from '@caffeinejs/std'

import { kServerOptions } from './keys.js'

export interface ServerOptions {
  port: number
  host: string
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = { port: 0, host: '0.0.0.0' }

/**
 * Where the server ended up listening, as reported by the bound socket — which is not what was asked for:
 * port `0` becomes an OS-assigned port, and a wildcard host stays a wildcard.
 */
export interface ServerAddress {
  /** The bound host, verbatim — a wildcard bind reports `0.0.0.0` or `::`. */
  readonly host: string
  /** The bound port. Never `0`. */
  readonly port: number
  /**
   * An origin that can be connected to. A wildcard {@link host} is rendered as the matching loopback address,
   * since `0.0.0.0` is an address to accept on, not one to dial.
   */
  readonly origin: string
}

/**
 * The shape the server expects wherever the application decides to keep its settings — import it into an
 * application schema (`$t.Object({ app: $t.Object({ server: serverConfigSchema }) })`) rather than restating
 * the fields, then hand that node to {@link ServerBuilder.config}.
 */
export const serverConfigSchema = $t.Object({
  port: $t.Number({ default: DEFAULT_SERVER_OPTIONS.port }),
  host: $t.String({ default: DEFAULT_SERVER_OPTIONS.host }),
})

/**
 * Configures the server address the adapter listens on when {@link WebApplication.run} is called.
 *
 * What a fluent method sets is final. To let the environment redirect the bind, read it from the
 * configuration — {@link serverConfigSchema} is exported so an application can splice it into its own schema
 * rather than restate the fields:
 *
 * ```ts
 * .server((s, c) => s.config(c.app.server))
 * ```
 *
 * The resolved options are bound under {@link kServerOptions}, which is how the adapter reads them without
 * knowing where the application put them. They are read once, when the feature configures — a refresh
 * afterward does not reach the bind address.
 */
export class ServerBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'server'

  #config: Partial<ServerOptions> | undefined
  #port: number | undefined
  #host: string | undefined

  /**
   * Reads the address from a node of the configuration tree, e.g. `c.app.server`.
   *
   * The node is read once, when the feature configures. {@link port} and {@link host} win over what the node
   * carries.
   */
  config(config: Partial<ServerOptions>): this {
    this.#config = config
    return this
  }

  port(port: number): this {
    this.#port = port
    return this
  }

  host(host: string): this {
    this.#host = host
    return this
  }

  protected configure(kit: FeatureConfigureKit<C>): void {
    const raw = { port: this.#port ?? this.#config?.port, host: this.#host ?? this.#config?.host }
    const options = { port: raw.port ?? DEFAULT_SERVER_OPTIONS.port, host: raw.host ?? DEFAULT_SERVER_OPTIONS.host }

    kit.container.bind(kServerOptions, t => t.toValue(options).internal())
  }
}
