import { kBootstrap, kFeatureName, type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { CorsExtension, type CorsOptions } from './extension.js'

/**
 * Configures `@fastify/cors`. Bound via `.extend(CORSExt, c => …)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link CorsExtension} and registers it with
 * the application's extensions, and the adapter runs it as a Fastify plugin.
 */
export class CorsBuilder implements FeatureLifecycle {
  readonly [kFeatureName] = 'cors'

  #options: CorsOptions = {}

  /**
   * Forwards an options bag to `@fastify/cors` (`origin`, `methods`, `credentials`, …).
   */
  options(opts: CorsOptions): this {
    this.#options = opts
    return this
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    kit.container.bind(CorsExtension, t => t.toValue(new CorsExtension(this.#options)))
    kit.extensions.add(CorsExtension)

    return Promise.resolve()
  }
}
