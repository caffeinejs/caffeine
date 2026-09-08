import { kBootstrap, kFeatureName, type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { MultipartExtension, type MultipartOptions } from './extension.js'

/**
 * Configures `@fastify/multipart`. Bound via `.extend(MultipartExt)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link MultipartExtension} and registers it
 * with the application's extensions, and the adapter runs it as a Fastify plugin.
 */
export class MultipartBuilder implements FeatureLifecycle {
  readonly [kFeatureName] = 'multipart'

  #options: MultipartOptions = {}

  /**
   * Forwards an options bag to `@fastify/multipart` (`limits`, `attachFieldsToBody`, …).
   */
  options(opts: MultipartOptions): this {
    this.#options = opts
    return this
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    kit.container.bind(MultipartExtension, t => t.toValue(new MultipartExtension(this.#options)))
    kit.extensions.add(MultipartExtension)

    return Promise.resolve()
  }
}
