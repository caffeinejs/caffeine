import { registerPlugin } from '@caffeinejs/http'
import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { splitOptionBag } from '@caffeinejs/std/config'

import { corsConfigSchema, type CORSConfig } from './config.js'
import { corsPlugin, type CorsOptions } from './cors_plugin.js'

/**
 * Configures `@fastify/cors`. Bound via `.extend(CORSExt(), c => …)`.
 *
 * Installing the feature is the activating act: its lifecycle contributes the CORS plugin and registers it with
 * the application's extensions, and the adapter runs it as a Fastify plugin. Configuration parameterizes the
 * mount but never switches it on, so a config file cannot start answering preflights for an application that
 * never asked.
 *
 * There is one read path. `c.options({ origin: 'https://app.example.com' })` does not hold the bag on the
 * builder — it writes it into the tree in the `CODE` band, so `CORS__OPTIONS__ORIGIN` overrides it. The
 * exception is a callback option (`origin` may be a function): a function cannot live in a configuration tree,
 * so those stay on the builder and are merged back afterwards.
 *
 * `C` is the application config type, so the {@link config} selector is typed against it.
 */
export class CorsBuilder<C = unknown> extends FeatureBuilder<CORSConfig, C> {
  readonly [kFeatureName] = 'cors'

  protected readonly schema = corsConfigSchema
  protected readonly defaults = { options: {} }

  #callbacks: Record<string, unknown> = {}

  /**
   * Forwards an options bag to `@fastify/cors` (`origin`, `methods`, `credentials`, …).
   */
  options(opts: CorsOptions): this {
    const { data, callbacks } = splitOptionBag(opts)
    this.#callbacks = callbacks

    return this.set('options', data)
  }

  protected bootstrap(kit: BootstrapKit): void {
    const options = { ...this.#callbacks, ...this.slice.config.options } as CorsOptions
    registerPlugin(kit, corsPlugin(options))
  }
}
