import type { IncomingMessage } from 'node:http'

import type { CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { AdapterTypes, ContextPlatform } from './adapter_types.js'
import type { FastifyMiddlewareHook } from './middleware/fastify.js'
import type { AnyFastifyPlugin } from './plugin.js'

/**
 * What `ctx.platform` is under the Fastify adapter: the request and the reply Fastify is serving.
 *
 * The way to reach what Fastify or one of its plugins added, such as `reply.view` or `request.parts()`.
 */
export interface FastifyPlatform<RES extends FastifyReply = FastifyReply> extends ContextPlatform {
  readonly name: 'fastify'
  readonly request: FastifyRequest
  readonly reply: RES
}

/** The Fastify adapter's {@link AdapterTypes}. */
export interface FastifyTypes<
  S extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> extends AdapterTypes {
  instance: S
  request: REQ
  extension: AnyFastifyPlugin
  hook: FastifyMiddlewareHook
  raw: IncomingMessage
  cookieOptions: CookieSerializeOptions
  asyncCookies: false
  platform: FastifyPlatform<RES>
}

/**
 * The Fastify adapter's types as a router is bound to them.
 *
 * A router depends on neither the server instance nor the request type, so both are left open, and a router bound
 * to this mounts on any Fastify application, including one built around its own instance. `newRouter()` returns one.
 */
export type FastifyRouterTypes = FastifyTypes<never, never>

declare module './adapter_types.js' {
  interface AdapterRegistry {
    fastify: FastifyTypes
  }
}
