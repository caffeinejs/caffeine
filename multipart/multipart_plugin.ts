import type { HTTPPlugin } from '@caffeinejs/http'
import fastifyMultipart from '@fastify/multipart'
import fp from 'fastify-plugin'

export type MultipartOptions = NonNullable<Parameters<typeof fastifyMultipart>[1]>

/**
 * Registers `@fastify/multipart` on the Fastify instance so upload pickers can read `req.parts()` / `req.files()`.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group.
 */
export function multipartPlugin(options: MultipartOptions = {}): HTTPPlugin {
  const plugin: HTTPPlugin = async instance => {
    await instance.register(fastifyMultipart, options)
  }

  return fp(plugin, { name: 'multipart' })
}
