import { FeatureBuilder, kFeatureName, type BootstrapKit } from '@caffeinejs/std'
import { splitOptionBag } from '@caffeinejs/std/config'

import { multipartConfigSchema, type MultipartConfig } from './config.js'
import { MultipartExtension, type MultipartOptions } from './extension.js'

/**
 * Configures `@fastify/multipart`. Bound via `.extend(MultipartExt())`.
 *
 * Installing the feature is the activating act: its lifecycle binds {@link MultipartExtension} and registers it
 * with the application's extensions, and the adapter runs it as a Fastify plugin. Configuration parameterizes
 * the mount but never switches it on.
 *
 * There is one read path. `m.options({ limits: { fileSize: 1_000_000 } })` does not hold the bag on the
 * builder — it writes it into the tree in the `CODE` band, so `MULTIPART__OPTIONS__LIMITS__FILE_SIZE`
 * overrides it, which is what lets an upload cap be raised on one deployment without a rebuild. The exception
 * is a callback option: a function cannot live in a configuration tree, so those stay on the builder and are
 * merged back afterwards.
 *
 * `C` is the application config type, so the {@link config} selector is typed against it.
 */
export class MultipartBuilder<C = unknown> extends FeatureBuilder<MultipartConfig, C> {
  readonly [kFeatureName] = 'multipart'

  protected readonly schema = multipartConfigSchema
  protected readonly defaults = { options: {} }

  #callbacks: Record<string, unknown> = {}

  /**
   * Forwards an options bag to `@fastify/multipart` (`limits`, `attachFieldsToBody`, …).
   */
  options(opts: MultipartOptions): this {
    const { data, callbacks } = splitOptionBag(opts)
    this.#callbacks = callbacks

    return this.set('options', data)
  }

  protected bootstrap(kit: BootstrapKit): Promise<void> {
    const options = { ...this.#callbacks, ...this.slice.config.options } as MultipartOptions
    kit.extensions.register(MultipartExtension, new MultipartExtension(options))

    return Promise.resolve()
  }
}
