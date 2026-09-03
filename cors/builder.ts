import { ServiceBootstrapIn, type Service, type ServiceAPI } from '@caffeinejs/std'
import { CorsExtension, type CorsOptions } from './extension.js'

/**
 * Configures `@fastify/cors`. Bound via `.extend(CORSExt, c => …)`.
 *
 * Installing the feature is the activating act: it binds {@link CorsExtension}, which the adapter
 * discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class CorsBuilder implements Service {
  #options: CorsOptions = {}

  get name(): string {
    return 'cors'
  }

  /**
   * Forwards an options bag to `@fastify/cors` (`origin`, `methods`, `credentials`, …).
   */
  options(opts: CorsOptions): ServiceAPI<this> {
    this.#options = opts
    return this
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    kit.container.bind(CorsExtension, t => t.toValue(new CorsExtension(this.#options)).extends())
    return Promise.resolve()
  }
}
