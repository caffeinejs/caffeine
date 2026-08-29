import { $t, type Service, type ServiceAPI, ServiceBeforeBootstrapIn } from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigHandle, type ConfigSlice } from '@caffeinejs/std/config'
import type { ServiceKit } from '../service.js'
import { kServerOptions } from './keys.js'

export interface ServerOptions {
  port: number
  host: string
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = { port: 0, host: '0.0.0.0' }

/** The default location of the server settings in the configuration tree. */
export const SERVER_CONFIG_NAMESPACE: readonly string[] = ['server']

const serverConfigSchema = $t.Object({
  port: $t.Number({ default: DEFAULT_SERVER_OPTIONS.port }),
  host: $t.String({ default: DEFAULT_SERVER_OPTIONS.host }),
})

/**
 * Configures the server address the adapter listens on when {@link WebApplication.run} is called.
 *
 * There is one read path. `s.port(3000)` does not hold the value on the builder — it writes it into the
 * configuration tree in the `CODE` band, and the server then reads the merged result like any other setting.
 * So a port set in code is a **default**: a `SERVER__PORT` environment variable or a `--server.port` argument
 * overrides it, which is what lets one image ship with sensible values and still be redirected on deploy.
 * Anything that must beat the environment is registered as a source of its own at a higher priority.
 *
 * By default the settings live at `server.*`. {@link config} re-points them — `s.config(c => c.app.server)`
 * moves both the reads and the code-set defaults to `app.server.*`, checked against the application schema.
 *
 * A {@link Service}: its {@link Service.configure} binds a fixed {@link ServerOptions} under
 * {@link kServerOptions}. That snapshot is deliberate — the listen address cannot change while the server runs,
 * so a config refresh does not move it.
 *
 * `C` is the application config type (flows from the builder once `.config(...)` is declared), so the selector
 * argument `c` is `ConfigHandle<C>`.
 */
export class ServerBuilder<C = unknown> implements Service {
  #port: number | undefined
  #host: string | undefined
  #selector?: (c: ConfigHandle<C>) => ServerOptions
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
   * Places the server settings elsewhere in the configuration tree, e.g. `s.config(c => c.app.server)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   * Both the reads and the defaults written by {@link port}/{@link host} follow it.
   */
  config(selector: (c: ConfigHandle<C>) => ServerOptions): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    this.#slice = defineFeatureConfig(kit.config, {
      namespace: SERVER_CONFIG_NAMESPACE,
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: serverConfigSchema,
      defaults: { ...DEFAULT_SERVER_OPTIONS },
      values: { port: this.#port, host: this.#host },
    })
  }

  bootstrap(kit: ServiceKit): Promise<void> {
    const slice = this.#slice!

    kit.container
      .bind<ServerOptions>(kServerOptions)
      // The slice's own object, not a copy: it is live, so its fields keep following refreshes like every
      // other configuration in the framework.
      //
      // The listen address still stops moving where it always did: the application spreads these options
      // immediately before the adapter binds the socket, and that copy is what the server runs on. Freezing
      // the whole object here instead would only mean nobody could ever see what configuration now says.
      .toValue(slice.config)
      .internal()

    return Promise.resolve()
  }
}
