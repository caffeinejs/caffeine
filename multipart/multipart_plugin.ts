import type { HTTPSetupContext } from '@caffeinejs/http'
import type { HTTPPluginFactory, RouterTypes } from '@caffeinejs/http/fastify'
import fastifyMultipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

export type MultipartOptions = NonNullable<Parameters<typeof fastifyMultipart>[1]>

/**
 * Registers `@fastify/multipart` so the upload pickers and `formData(ctx)` can read the parts: `.with(multipart())`.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group; registering it on one
 * router parses uploads for that group alone.
 *
 * `options` runs once, when the factory builds the plugin, and is handed the setup context, so the options can
 * come from the application's configuration:
 *
 * ```ts
 * .with(multipart(({ config }) => config.app.multipart))
 * ```
 */
export function multipart<C = unknown>(
  options?: (context: HTTPSetupContext<C, RouterTypes>) => MultipartOptions,
): HTTPPluginFactory<C> {
  return context => {
    // A copy: `@fastify/multipart` writes its resolved limits back into its options, and a configuration node is
    // read-only.
    const settings = { ...options?.(context) }
    const plugin: FastifyPluginAsync = async instance => {
      await instance.register(fastifyMultipart, settings)
    }

    return fp(plugin, { name: '@caffeinejs/multipart' })
  }
}
