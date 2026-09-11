import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'

import { registerPlugin, type HTTPPluginFactory } from './plugin.js'

let counter = 0

/**
 * The {@link Feature} a plugin registered with `.extend(c => …)` is carried as.
 *
 * A plugin goes in the same list as a feature so that the two interleave in the order they were written, which
 * is the order they register on Fastify. Nothing else about it is special.
 *
 * Its name is generated rather than chosen, so a plugin is never deduplicated: registering the same factory
 * twice registers the plugin twice, which is what a caller asking for two of something means.
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

  async [kBootstrap](kit: BootstrapKit<C>): Promise<void> {
    registerPlugin(kit, await this.#factory(kit.config, kit.container))
  }
}
