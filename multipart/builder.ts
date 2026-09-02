import { ServiceBootstrapIn, type Service, type ServiceAPI } from '@caffeinejs/std'
import { MultipartExtension, type MultipartOptions } from './extension.js'

/**
 * Configures `@fastify/multipart`. Bound via `.extend(MultipartExt)`.
 *
 * Installing the feature is the activating act: it binds {@link MultipartExtension}, which the adapter
 * discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class MultipartBuilder implements Service {
  #options: MultipartOptions = {}

  get name(): string {
    return 'multipart'
  }

  /**
   * Forwards an options bag to `@fastify/multipart` (`limits`, `attachFieldsToBody`, …).
   */
  options(opts: MultipartOptions): ServiceAPI<this> {
    this.#options = opts
    return this
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    kit.container.bind(MultipartExtension).toValue(new MultipartExtension(this.#options)).extends()
    return Promise.resolve()
  }
}
