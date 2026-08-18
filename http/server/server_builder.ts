import { ErrConfigSourceConflict, kAppConfig, kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { ServiceKit } from '../service.js'
import { kServerOptions } from './keys.js'

export interface ServerOptions {
  port: number
  host: string
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = { port: 0, host: '0.0.0.0' }

/**
 * Configures the server address the adapter listens on when {@link WebApplication.run} is called. Bound via
 * `app.server(s => s.port(3000).host('127.0.0.1'))` or, alternatively, from application config with
 * `app.server(s => s.config(c => c.server))`.
 *
 * A {@link Service}: its {@link kServiceConfigure} binds a fixed {@link ServerOptions} under
 * {@link kServerOptions}. Both paths produce a one-time snapshot — the listen address cannot change while the
 * server runs, so config refresh deliberately does **not** move it:
 * - the **config selector** reads the app-config slice once (already validated by the application schema at
 *   bootstrap, and typed at compile time), detaching from the live proxy;
 * - the **builder methods** capture the values set here.
 *
 * The two paths are mutually exclusive — using both throws {@link ErrConfigSourceConflict}.
 *
 * `C` is the application config type (flows from the builder once `.config(...)` is declared), so the selector
 * argument `c` is `ConfigHandle<C>`.
 */
export class ServerBuilder<C = unknown> implements Service {
  #port = DEFAULT_SERVER_OPTIONS.port
  #host = DEFAULT_SERVER_OPTIONS.host
  #usedBuilderFn = false
  #selector?: (c: ConfigHandle<C>) => ServerOptions

  port(port: number): this {
    this.#port = port
    this.#usedBuilderFn = true
    return this
  }

  host(host: string): this {
    this.#host = host
    this.#usedBuilderFn = true
    return this
  }

  /** Drives the server address from the application config, e.g. `s.config(c => c.server)`. */
  config(selector: (c: ConfigHandle<C>) => ServerOptions): this {
    this.#selector = selector
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (this.#selector !== undefined && this.#usedBuilderFn) {
      throw new ErrConfigSourceConflict('server')
    }

    if (this.#selector !== undefined) {
      const container = kit.container
      const selector = this.#selector
      kit.container
        .bind<ServerOptions>(kServerOptions)
        // Lazy so `kAppConfig` (bound during init) is available; runs once, then the singleton caches it.
        .toFactory(() => {
          const appConfig = container.getOptional<ConfigHandle<C>>(kAppConfig)
          if (appConfig === undefined) {
            throw new Error('Cannot select server config: no application config defined — declare .config(...) before configuring the server')
          }
          // Snapshot: the listen address is fixed once the server starts, so a later config refresh must not
          // move it. A fresh plain object also detaches from the live app-config proxy.
          const slice = selector(appConfig)
          return { port: slice.port, host: slice.host }
        })
        .internal()
      return Promise.resolve()
    }

    // Builder-fn (or default) path: a fixed plain object, same as the snapshot the selector path produces.
    const options: ServerOptions = { port: this.#port, host: this.#host }
    kit.container
      .bind<ServerOptions>(kServerOptions)
      .toValue(options)
      .internal()
    return Promise.resolve()
  }
}
