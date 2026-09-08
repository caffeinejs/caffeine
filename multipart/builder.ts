import { kFeatureSetup, type BootstrapKit, type FeatureLifecycle, type FeatureProvider } from '@caffeinejs/std'

import { MultipartExtension, type MultipartOptions } from './extension.js'

/**
 * Configures `@fastify/multipart`. Bound via `.extend(MultipartExt)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link MultipartExtension}, which the
 * adapter discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class MultipartBuilder implements FeatureProvider {
  #options: MultipartOptions = {}

  /**
   * Forwards an options bag to `@fastify/multipart` (`limits`, `attachFieldsToBody`, …).
   */
  options(opts: MultipartOptions): this {
    this.#options = opts
    return this
  }

  [kFeatureSetup](): FeatureLifecycle {
    return {
      name: 'multipart',

      bootstrap: (kit: BootstrapKit): Promise<void> => {
        kit.container.bind(MultipartExtension, t => t.toValue(new MultipartExtension(this.#options)).extends())
        return Promise.resolve()
      },
    }
  }
}
