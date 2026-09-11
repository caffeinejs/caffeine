import { $t, FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { liveFold, type ConfigLocation } from '@caffeinejs/std/config'

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
 * the fields, then hand that node to {@link ServerBuilder.withConfig}.
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
 * .server((s, c) => s.withConfig(c.app.server))
 * ```
 *
 * The resolved options are bound under {@link kServerOptions}, which is how the adapter reads them without
 * knowing where the application put them. What it reads is live, but the listen address still stops moving
 * once the socket is bound: the adapter copies these options immediately before binding, and that copy is what
 * the server runs on.
 */
export class ServerBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'server'

  #config: ConfigLocation<ServerOptions> | undefined
  #port: number | undefined
  #host: string | undefined

  /**
   * Reads the address from a node of the configuration tree, e.g. `c.app.server`.
   *
   * The node is read, never copied, so a refresh reaches whatever has not bound yet. {@link port} and
   * {@link host} win over what the node carries.
   */
  withConfig(config: ConfigLocation<ServerOptions>): this {
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

  protected bootstrap(kit: BootstrapKit<C>): void {
    const options = liveFold(
      () => ({ port: this.#port ?? this.#config?.port, host: this.#host ?? this.#config?.host }),
      raw => ({ port: raw.port ?? DEFAULT_SERVER_OPTIONS.port, host: raw.host ?? DEFAULT_SERVER_OPTIONS.host }),
    )

    kit.container.bind(kServerOptions, t => t.toValue(options).internal())
  }
}
