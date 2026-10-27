import fastifyMultipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { kCount, kThrowFileSizeLimit } from './_parts.js'

export type MultipartOptions = NonNullable<Parameters<typeof fastifyMultipart>[1]>

/**
 * Registers `@fastify/multipart` on the Fastify instance so upload pickers can read `req.parts()` / `req.files()`.
 *
 * `fastify-plugin`-wrapped, so registering it on the application reaches every route group.
 *
 * On a route that declares no `bodyLimit`, `limits` alone hold an upload, and nothing holds the body as a whole. A file
 * over `limits.fileSize`, the server's `bodyLimit` unless set, is answered 413 `FST_REQ_FILE_TOO_LARGE` whichever
 * reader reads it, or handed over cut short under `throwFileSizeLimit: false`. A route's own limit, `.bodyLimit()` or
 * `@BodyLimit()`, holds the whole upload as it holds any other body, and takes the place of `fileSize` on that route:
 * an upload over it is answered 413 `FST_ERR_CTP_BODY_TOO_LARGE`.
 */
export function multipartPlugin(options: MultipartOptions = {}): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    await instance.register(fastifyMultipart, options)
    instance.decorate(kThrowFileSizeLimit, options.throwFileSizeLimit !== false)
    instance.decorateRequest(kCount, null)
  }

  return fp(plugin, { name: '@caffeinejs/multipart' })
}
