import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { splitOptionBag } from '@caffeinejs/std/config'

import { compressConfigSchema, type CompressConfig } from './config.js'
import { CompressExtension, type CompressOptions } from './extension.js'

/**
 * Configures `@fastify/compress`. Bound via `.extend(CompressExt, c => …)`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link CompressExtension} and registers it
 * with the application's extensions, and the adapter runs it as a Fastify plugin. Configuration parameterizes
 * the mount but never switches it on.
 *
 * There is one read path. `c.options({ threshold: 2048 })` does not hold the bag on the builder — it writes it
 * into the tree in the `CODE` band, so `COMPRESS__OPTIONS__THRESHOLD` overrides it. The exception is a callback
 * option: a function cannot live in a configuration tree, so those stay on the builder and are merged back
 * afterwards.
 *
 * `C` is the application config type, so the {@link config} selector is typed against it.
 */
export class CompressBuilder<C = unknown> extends FeatureBuilder<CompressConfig, C> {
  readonly [kFeatureName] = 'compress'

  protected readonly schema = compressConfigSchema
  protected readonly defaults = { options: {} }

  #callbacks: Record<string, unknown> = {}

  /**
   * Forwards an options bag to `@fastify/compress` (`threshold`, `encodings`, `global`, …).
   */
  options(opts: CompressOptions): this {
    const { data, callbacks } = splitOptionBag(opts)
    this.#callbacks = callbacks

    return this.set('options', data)
  }

  protected bootstrap(kit: BootstrapKit): Promise<void> {
    const options = { ...this.#callbacks, ...this.slice.config.options } as CompressOptions
    kit.extensions.register(CompressExtension, new CompressExtension(options))

    return Promise.resolve()
  }
}
