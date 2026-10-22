import fastifyMultipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

export type MultipartOptions = NonNullable<Parameters<typeof fastifyMultipart>[1]>

/**
 * Registers `@fastify/multipart` on the Fastify instance so upload pickers can read `req.parts()` / `req.files()`.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group.
 *
 * On a route that declares no `bodyLimit`, `limits` alone hold an upload: each file is held to `limits.fileSize`, the
 * server's `bodyLimit` unless set, and nothing holds the body as a whole. A route's own limit, `.bodyLimit()` or
 * `@BodyLimit()`, holds the whole upload as it holds any other body, and takes the place of `fileSize` on that route:
 * an upload over it is answered 413 `FST_ERR_CTP_BODY_TOO_LARGE`.
 */
export function multipartPlugin(options: MultipartOptions = {}): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    await instance.register(fastifyMultipart, options)
  }

  return fp(plugin, { name: '@caffeinejs/multipart' })
}
