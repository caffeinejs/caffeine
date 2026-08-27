import { kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ServiceKit } from '@caffeinejs/http'
import { MultipartExtension, type MultipartOptions } from './extension.js'

/**
 * Configures `@fastify/multipart`. Bound via `app.multipart(...)`.
 *
 * Reaching `.multipart()` is the activating act: it binds {@link MultipartExtension}, which the adapter
 * discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class MultipartBuilder implements Service {
  #options: MultipartOptions = {}

  /**
   * Forwards an options bag to `@fastify/multipart` (`limits`, `attachFieldsToBody`, …).
   */
  options(opts: MultipartOptions): this {
    this.#options = opts
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    kit.container.bind(MultipartExtension).toValue(new MultipartExtension(this.#options)).extends()
    return Promise.resolve()
  }
}
