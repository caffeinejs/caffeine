import { $t, FeatureBuilder, kFeatureName } from '@caffeinejs/std'

import { kServerConfig } from './keys.js'

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
 * the fields, then point the server at it with {@link ServerBuilder.config}.
 */
export const serverConfigSchema = $t.Object({
  port: $t.Number({ default: DEFAULT_SERVER_OPTIONS.port }),
  host: $t.String({ default: DEFAULT_SERVER_OPTIONS.host }),
})

/**
 * Configures the server address the adapter listens on when {@link WebApplication.run} is called.
 *
 * {@link config} is what puts these settings in the configuration tree: `s.config(c => c.app.server)` places
 * them at `app.server.*`, checked against the application's own schema — {@link serverConfigSchema} is exported
 * to be spliced into it. Without it the server runs on its defaults and whatever {@link port}/{@link host} set,
 * and no file, environment variable or argument reaches it.
 *
 * Once placed, there is one read path. `s.port(3000)` does not hold the value on the builder — it writes it
 * into the tree in the `CODE` band, and the server reads the merged result like any other setting. So a port
 * set in code is a **default**: `APP__SERVER__PORT` or `--app.server.port` overrides it, which is what lets one
 * image ship with sensible values and still be redirected on deploy. Anything that must beat the environment is
 * registered as a source of its own at a higher priority.
 *
 * The settings are published under {@link kServerConfig}, which is how the adapter reads them without knowing
 * where the application put them. What it reads is live, but the listen address still stops moving once the
 * socket is bound: the adapter copies these options immediately before binding, and that copy is what the
 * server runs on.
 *
 * `C` is the application config type (flows from the builder once `.config(...)` is declared), so the selector
 * argument `c` is `ConfigHandle<C>`.
 */
export class ServerBuilder<C = unknown> extends FeatureBuilder<ServerOptions, C> {
  readonly [kFeatureName] = 'server'

  protected readonly schema = serverConfigSchema
  protected readonly configKey = kServerConfig
  protected readonly defaults = { ...DEFAULT_SERVER_OPTIONS }

  port(port: number): this {
    return this.set('port', port)
  }

  host(host: string): this {
    return this.set('host', host)
  }

  protected bootstrap(): void {
    // Nothing to bind: the adapter reads the settings by key.
  }
}
