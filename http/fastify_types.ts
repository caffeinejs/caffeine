import type { IncomingMessage, Server } from 'node:http'

import type { CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyHttpOptions, FastifyInstance, FastifyListenOptions, FastifyReply, FastifyRequest } from 'fastify'

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

/**
 * What `.server(configure)` returns under the Fastify adapter.
 *
 * ```ts
 * .server(({ config }) => ({ factory: { bodyLimit: 1_048_576 }, listener: config.app.server }))
 * ```
 */
export interface FastifyServerSettings {
  /**
   * What `Fastify(...)` is constructed with. The application's configured logger is the server's, with request
   * logging off, unless `logger` or `loggerInstance` is set here. `https` and `http2` are not accepted: they
   * change the instance type.
   */
  factory?: FastifyHttpOptions<Server>

  /**
   * What `listen()` is called with. What `run(options)` is given is merged over it, key by key. With neither,
   * Fastify's own default applies (`localhost`, an OS-assigned port); a `host` without a `port` is refused by
   * Node, so write `port: 0` for an OS-assigned port.
   */
  listener?: FastifyListenOptions
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
  serverOptions: FastifyServerSettings
  runArgs: [options?: FastifyListenOptions]
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
