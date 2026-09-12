import type { Container } from '@caffeinejs/di'
import { kFeatureBootstrap, kFeatureConfigure, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'

import { registerPlugin, type HTTPPluginFactory } from './plugin.js'

let counter = 0

/**
 * The {@link Feature} a plugin registered with `.plugin(c => …)` is carried as.
 *
 * A plugin goes in the same list as a feature so that the two interleave in the order they were written, which
 * is the order they register on Fastify. Nothing else about it is special.
 *
 * Its name is generated rather than chosen, so two `.plugin` of the same factory install two features. An
 * unnamed plugin therefore registers twice; a `fastify-plugin` name already on that Fastify instance is
 * refused at register time.
 */
export class HTTPPluginFeature<C = unknown> implements Feature<C> {
  readonly #factory: HTTPPluginFactory<C>
  readonly #name = `plugin:${++counter}`

  constructor(factory: HTTPPluginFactory<C>) {
    this.#factory = factory
  }

  get [kFeatureName](): string {
    return this.#name
  }

  [kFeatureConfigure](): void {
    // Nothing to bind.
  }

  /**
   * Calls the factory and registers the plugin. Bootstrap is after `container.init()`, so `get()` is legal.
   * The position this feature bootstrapped at is what keeps its plugin in the order it was written, not when
   * the factory happens to finish.
   */
  async [kFeatureBootstrap](kit: BootstrapKit<C>): Promise<void> {
    registerPlugin(kit, await this.#factory(kit.config, kit.container as Container))
  }
}
