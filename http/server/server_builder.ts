import { $t, type Service, type ServiceAPI, ServiceBeforeBootstrapIn, ServiceBootstrapIn } from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigHandle, type ConfigLocation, type ConfigSlice } from '@caffeinejs/std/config'

import { kServerContribution, kServerOptions } from './keys.js'

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
 * A {@link Service}: its `bootstrap` contributes the live {@link ServerOptions} under
 * {@link kServerContribution}. The listen address still stops moving once the socket is bound — the
 * application copies these options immediately before binding, and that copy is what the server runs on.
 *
 * `C` is the application config type (flows from the builder once `.config(...)` is declared), so the selector
 * argument `c` is `ConfigHandle<C>`.
 */
export class ServerBuilder<C = unknown> implements Service {
  #port: number | undefined
  #host: string | undefined
  #selector?: (c: ConfigHandle<C>) => ConfigLocation<ServerOptions>
  #slice: ConfigSlice<ServerOptions> | undefined

  get name(): string {
    return 'server'
  }

  port(port: number): ServiceAPI<this> {
    this.#port = port
    return this
  }

  host(host: string): ServiceAPI<this> {
    this.#host = host
    return this
  }

  /**
   * Places the server settings in the configuration tree, e.g. `s.config(c => c.app.server)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   * Both the reads and the defaults written by {@link port}/{@link host} go there. The application's schema
   * must describe that location — {@link serverConfigSchema} is exported for exactly that — though it need
   * only describe the part it wants to control: a location declaring `port` alone is a location, and `host`
   * then comes from {@link host}, the defaults, or the environment.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigLocation<ServerOptions>): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    this.#slice = defineFeatureConfig(kit.config, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: serverConfigSchema,
      defaults: { ...DEFAULT_SERVER_OPTIONS },
      values: { port: this.#port, host: this.#host },
    })
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    const slice = this.#slice!

    // The slice's own object, not a copy: it is live, so its fields keep following refreshes like every
    // other configuration in the framework.
    //
    // The listen address still stops moving where it always did: the application spreads these options
    // immediately before the adapter binds the socket, and that copy is what the server runs on. Freezing
    // the whole object here instead would only mean nobody could ever see what configuration now says.
    kit.contributions.contribute(kServerContribution, slice.config)

    // The same object as a binding, for a class the container constructs rather than the builder. `toValue` is
    // right because the slice's identity is stable — the fields still follow a refresh.
    kit.container.bind(kServerOptions, t => t.toValue(slice.config))

    return Promise.resolve()
  }
}
