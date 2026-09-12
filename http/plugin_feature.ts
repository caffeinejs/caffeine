import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'

import type { HTTPPluginFactory } from './plugin.js'
import type { HTTPExtensionRegistrar } from './plugin_registry.js'

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

  /**
   * Hands the factory over rather than calling it: bootstrap runs before `container.init()`, so a factory
   * that resolves from the container (`container.get(...)`) would throw here. `WebApplication.setup()` calls
   * it later, through {@link HTTPPlugins.resolveDeferred}, once the container is up — the position this
   * feature bootstrapped at is what keeps its plugin in the order it was written, not when that call happens.
   */
  [kBootstrap](kit: BootstrapKit<C>): void {
    ;(kit.extensions as HTTPExtensionRegistrar<C>).registerDeferred(this.#factory)
  }
}
