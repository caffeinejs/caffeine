import { kFeatureSetup, type BootstrapKit, type FeatureLifecycle, type FeatureProvider } from '@caffeinejs/std'

import { CorsExtension, type CorsOptions } from './extension.js'

/**
 * Configures `@fastify/cors`. Bound via `.extend(CORSExt, c => …)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link CorsExtension}, which the adapter
 * discovers via `getManyOptional(ServerExtension)` and registers as a Fastify plugin.
 */
export class CorsBuilder implements FeatureProvider {
  #options: CorsOptions = {}

  /**
   * Forwards an options bag to `@fastify/cors` (`origin`, `methods`, `credentials`, …).
   */
  options(opts: CorsOptions): this {
    this.#options = opts
    return this
  }

  [kFeatureSetup](): FeatureLifecycle {
    return {
      name: 'cors',

      bootstrap: (kit: BootstrapKit): Promise<void> => {
        kit.container.bind(CorsExtension, t => t.toValue(new CorsExtension(this.#options)).extends())
        return Promise.resolve()
      },
    }
  }
}
