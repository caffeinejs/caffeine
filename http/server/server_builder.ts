import { kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ServiceKit } from '../service.js'
import { kServerOptions } from './keys.js'

export interface ServerOptions {
  port: number
  host: string
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = { port: 0, host: '0.0.0.0' }

/**
 * Configures the server address the adapter listens on when {@link WebApplication.run} is called. Bound
 * via `app.server(s => s.port(3000).host('127.0.0.1'))`.
 *
 * A {@link Service}, like {@link CacheBuilder}: its {@link kServiceConfigure} binds the resolved
 * {@link ServerOptions} into the container under {@link kServerOptions}. Port and host default to
 * {@link DEFAULT_SERVER_OPTIONS} (`0` / `0.0.0.0`, Fastify's own defaults), so a partial config still
 * binds a full value. When the builder is never used, `run()` falls back to the same defaults.
 */
export class ServerBuilder implements Service {
  #port = DEFAULT_SERVER_OPTIONS.port
  #host = DEFAULT_SERVER_OPTIONS.host

  port(port: number): this {
    this.#port = port
    return this
  }

  host(host: string): this {
    this.#host = host
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    kit.container.bind(kServerOptions).toValue({ port: this.#port, host: this.#host }).internal()
    return Promise.resolve()
  }
}
