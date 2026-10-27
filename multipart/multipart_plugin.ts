import type { HTTPSetupContext } from '@caffeinejs/http'
import type { HTTPPluginFactory, RouterTypes } from '@caffeinejs/http/fastify'
import fastifyMultipart from '@fastify/multipart'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { kCount, kThrowFileSizeLimit } from './_parts.js'

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
 *
 * On a route that declares no `bodyLimit`, `limits` alone hold an upload, and nothing holds the body as a whole. A file
 * over `limits.fileSize`, the server's `bodyLimit` unless set, is answered 413 `FST_REQ_FILE_TOO_LARGE` whichever
 * reader reads it, or handed over cut short under `throwFileSizeLimit: false`. A route's own limit, `.bodyLimit()` or
 * `@BodyLimit()`, holds the whole upload as it holds any other body, and takes the place of `fileSize` on that route:
 * an upload over it is answered 413 `FST_ERR_CTP_BODY_TOO_LARGE`.
 */
export function multipart<C = unknown>(
  options?: (context: HTTPSetupContext<C, RouterTypes>) => MultipartOptions,
): HTTPPluginFactory<C> {
  return context => {
    // A copy: `@fastify/multipart` writes its resolved limits back into its options, and a configuration node is
    // read-only.
    const settings: MultipartOptions = { ...options?.(context) }
    const plugin: FastifyPluginAsync = async instance => {
      await instance.register(fastifyMultipart, settings)
      instance.decorate(kThrowFileSizeLimit, settings.throwFileSizeLimit !== false)
      instance.decorateRequest(kCount, null)
    }

    return fp(plugin, { name: '@caffeinejs/multipart' })
  }
}
