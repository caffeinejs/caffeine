import { kBootstrap, kFeatureName, type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { CompressExtension, type CompressOptions } from './extension.js'

/**
 * Configures `@fastify/compress`. Bound via `.extend(CompressExt, c => …)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link CompressExtension} and registers it
 * with the application's extensions, and the adapter runs it as a Fastify plugin.
 */
export class CompressBuilder implements FeatureLifecycle {
  readonly [kFeatureName] = 'compress'

  #options: CompressOptions = {}

  /**
   * Forwards an options bag to `@fastify/compress` (`threshold`, `encodings`, `global`, …).
   */
  options(opts: CompressOptions): this {
    this.#options = opts
    return this
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    kit.container.bind(CompressExtension, t => t.toValue(new CompressExtension(this.#options)))
    kit.extensions.add(CompressExtension)

    return Promise.resolve()
  }
}
