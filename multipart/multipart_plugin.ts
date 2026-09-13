import fastifyMultipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

export type MultipartOptions = NonNullable<Parameters<typeof fastifyMultipart>[1]>

/**
 * Registers `@fastify/multipart` on the Fastify instance so upload pickers can read `req.parts()` / `req.files()`.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group.
 */
export function multipartPlugin(options: MultipartOptions = {}): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    await instance.register(fastifyMultipart, options)
  }

  return fp(plugin, { name: 'multipart' })
}
