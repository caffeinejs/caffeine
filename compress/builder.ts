import { ServiceBootstrapIn, type Service, type ServiceAPI } from '@caffeinejs/std'

import { CompressExtension, type CompressOptions } from './extension.js'

/**
 * Configures `@fastify/compress`. Bound via `.extend(CompressExt, c => …)`.
 *
 * Installing the feature is the activating act: it binds {@link CompressExtension}, which the adapter
 * discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class CompressBuilder implements Service {
  #options: CompressOptions = {}

  get name(): string {
    return 'compress'
  }

  /**
   * Forwards an options bag to `@fastify/compress` (`threshold`, `encodings`, `global`, …).
   */
  options(opts: CompressOptions): ServiceAPI<this> {
    this.#options = opts
    return this
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    kit.container.bind(CompressExtension, t => t.toValue(new CompressExtension(this.#options)).extends())
    return Promise.resolve()
  }
}
