import { kFeatureSetup, type BootstrapKit, type FeatureLifecycle, type FeatureProvider } from '@caffeinejs/std'

import { CompressExtension, type CompressOptions } from './extension.js'

/**
 * Configures `@fastify/compress`. Bound via `.extend(CompressExt, c => …)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link CompressExtension}, which the
 * adapter discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class CompressBuilder implements FeatureProvider {
  #options: CompressOptions = {}

  /**
   * Forwards an options bag to `@fastify/compress` (`threshold`, `encodings`, `global`, …).
   */
  options(opts: CompressOptions): this {
    this.#options = opts
    return this
  }

  [kFeatureSetup](): FeatureLifecycle {
    return {
      name: 'compress',

      bootstrap: (kit: BootstrapKit): Promise<void> => {
        kit.container.bind(CompressExtension, t => t.toValue(new CompressExtension(this.#options)).extends())
        return Promise.resolve()
      },
    }
  }
}
