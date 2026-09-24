import { Readable } from 'node:stream'

import { Ctor } from '@caffeinejs/di'
import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerBase,
} from 'fastify'

import { installRouteGroupErrorHandler, type GlobalErrorHandler } from '../../error/plugin.js'
import { attachGuardHook } from '../../guards/fastify.js'
import { Responder } from '../../response.js'
import { compileRouteSchema } from '../../schema/compile_route_schema.js'
import type { RouteCompilers, RouteGroup } from '../route.js'
import { type CaffeineRouteConfig, type CompiledRouteMetadata } from './route_config.js'
import { type AdapterRouteOptions } from './route_options.js'

/** The `onRequest` hook shape Fastify takes, which is the one a route source builds its group hook in. */
type OnRequestHook = (req: FastifyRequest, res: FastifyReply, done: (err?: Error) => void) => void

/** What is the same for every group on one server, resolved once before any of them registers. */
export interface RouteGroupRegistration<REQ> {
  /**
   * Installs what `scope` (a mounted router, or a controller class) asked for with `.plugin(...)` /
   * `@Use(...)` on the context it is handed, refusing what the root server would refuse.
   */
  installScope: (server: FastifyInstance, scope: object) => Promise<void>
  compilers: RouteCompilers<REQ>
  globalErrorHandler: GlobalErrorHandler
  /** The server's own `handlerTimeout`, when it set one. */
  handlerTimeout?: number
}

/**
 * Turns one compiled {@link RouteGroup} into real Fastify routes: schema compilation, per-route config
 * assembly, guard attachment, the `BodyAsBuffer`/`BodyAsStream` content-type-parser swap.
 *
 * Every route lands in the group's own `register()` context, so the group's error handler and the plugins a
 * `router.plugin(...)` / `@Use(...)` installed cover these routes and no others.
 */
export function registerCompiledRouteGroup<REQ extends FastifyRequest>(
  instance: FastifyInstance,
  router: RouteGroup<REQ>,
  registration: RouteGroupRegistration<REQ>,
): void {
  const { installScope, compilers, globalErrorHandler, handlerTimeout } = registration
  const basePath = router.path
  const routes = router.routes

  instance.register(
    async server => {
      installRouteGroupErrorHandler(server, router, globalErrorHandler)

      // What a mounted router or a controller installed with `.plugin(...)` / `@Use(...)`. The same
      // plugin as an application-level one, registered in this group's context instead of on the root
      // server — so a `fastify-plugin`-wrapped plugin covers this group's routes and no others.
      for (const scope of router.scopes ?? []) {
        await installScope(server, scope)
      }

      // Whatever preparation the source that built this group needs — resolving the instance a `@Catch`
      // method will run on, for one. Registered as given, so it costs what the hook it replaces cost.
      if (router.onRequest !== undefined) {
        server.addHook('onRequest', router.onRequest as OnRequestHook)
      }

      for (const route of routes) {
        // Built here, once. The source decides *how* the route is invoked — a method on a singleton, one
        // resolved per request, a plain function — and hands back the function to install.
        const handle = route.dispatch(compilers) as (req: REQ, res: unknown) => unknown

        // Only a timed route reads `req.signal` below: on any other, the read would create a controller per request.
        // Fastify creates no timer for a `handlerTimeout` of 0, so that server is not timed either.
        const timed = route.timeout !== undefined || (handlerTimeout !== undefined && handlerTimeout > 0)

        // Route Config
        // https://fastify.dev/docs/latest/Reference/Routes/#config
        const config: Record<string | symbol, unknown> = {}
        if (route.config) {
          for (const [k, v] of route.config) {
            config[k] = v
          }
        }

        // Route Options
        // https://fastify.dev/docs/latest/Reference/Routes/#routes-options
        const options: Record<string | symbol, unknown> = {}
        if (route.options) {
          for (const [k, v] of route.options) {
            options[k] = v
          }
        }

        const status = route.statusCode!
        const hasStatus = typeof status === 'number' && status > 0
        const contentType = route.contentType
        const hasContentType = typeof contentType === 'string' && contentType.length > 0
        const header = [] as Array<[string, string | string[]]>
        if (route.header) {
          for (const [k, v] of route.header) {
            header.push([k, v])
          }
        }
        const hasHeader = header.length > 0

        // Read by the handler below off this very binding rather than off the route config, so the per-request
        // lookup is gone; every `onRoute` reader still finds it under `config.$caffeine.compiled`.
        const compiled: CompiledRouteMetadata<REQ> = {
          route,
          group: router,
          hasStatus,
          status,
          hasContentType,
          contentType,
          hasHeader,
          header,
          catchBy: route.catchBy,
        }

        config.$caffeine = {
          compiled,
          skipAuthentication: false,
          // The authentication middleware is registered once, for the whole server, so what a route
          // declared has to travel with the route rather than be closed over per registration.
          auth: {
            schemes: route.authorization.options?.schemes,
            allowAnonymous: route.authorization.options?.allowAnonymous === true,
            authorizer: route.authorization.authorizer,
          },
        } satisfies CaffeineRouteConfig<REQ>

        const url = joinPaths(basePath, route.path)

        const routeDef: AdapterRouteOptions = {
          method: [...new Set(route.method.map(m => m.toUpperCase()))],
          url,
          // Compiled here, once, so Fastify's Ajv owns request validation with zero schema work per request.
          schema: compileRouteSchema(route.schema, `${route.method.join('|')} ${url}`),
          bodyLimit: route.bodyLimit,
          handlerTimeout: route.timeout,
          config,
          ...options,
          handler: function (req, res) {
            if (compiled.hasHeader) {
              for (let i = 0; i < compiled.header.length; i++) {
                const item = compiled.header[i]
                res.header(item[0], item[1])
              }
            }

            if (compiled.hasContentType) {
              res.type(compiled.contentType)
            }

            if (compiled.hasStatus) {
              res.code(compiled.status)
            }

            const result = handle(req as REQ, res)

            if (result instanceof Promise) {
              return result.then(
                r => {
                  // The handler outlived its timeout: Fastify has answered 503 and is sending it. Handed the reply
                  // itself, the server waits for that send to end instead of starting another with this result.
                  if (timed && req.signal.aborted && isHandlerTimeout(req.signal.reason)) {
                    return res
                  }

                  // The handler answered the request itself — `ctx.redirect(...)`, then whatever it returned. The
                  // reply is handed back so the server waits on the send already in flight instead of starting a
                  // second over it, which is what `undefined` here would do, and what a value or a `Responder`
                  // would do too, while an `onSend` hook that awaits keeps `reply.sent` false. On a reply already
                  // out it returns at once.
                  if (req.httpContext.sent) {
                    return res
                  }

                  if (r instanceof Responder) {
                    return r.respond(req.httpContext)
                  }

                  if (r === undefined) {
                    res.send()
                    return res
                  }

                  return r
                },
                (err: unknown) => {
                  // A rejection after the timeout is the late result too: the 503 is what answers the request.
                  if (timed && req.signal.aborted && isHandlerTimeout(req.signal.reason)) {
                    req.log.error({ err }, 'Handler rejected after its timeout; the 503 stands')
                    return res
                  }

                  throw err
                },
              )
            }

            // As above, minus the reply: the server sends nothing of its own over a handler that returned
            // synchronously, so there is no second send here to make it wait for.
            if (req.httpContext.sent) {
              return
            }

            if (result instanceof Responder) {
              return result.respond(req.httpContext)
            }

            if (result === undefined) {
              res.send()
              return
            }

            return result
          },
        }

        const routeFn = (s: FastifyInstance, def: AdapterRouteOptions) =>
          (
            s as FastifyInstance<
              RawServerBase,
              RawRequestDefaultExpression<RawServerBase>,
              RawReplyDefaultExpression<RawServerBase>
            >
          ).route(def)

        if (route.guards !== undefined && route.guards.length > 0) {
          // Built here rather than in the hook: it is the same object for every request on this route.
          attachGuardHook(routeDef, route.guards, {
            clazz: router.target as Ctor<unknown> | undefined,
            handler: route.name,
          })
        }

        // BodyAsBuffer
        // When the route is decorated with @BodyAsBuffer(), the body is read as a raw buffer.
        if (route.bodyAs === 'buffer') {
          server.register(async innerServer => {
            innerServer.removeAllContentTypeParsers()
            innerServer.addContentTypeParser('*', { bodyLimit: route.bodyLimit }, function (_request, payload, done) {
              const chunks: Buffer[] = []
              payload.on('data', (chunk: Buffer) => chunks.push(chunk))
              payload.on('end', () => done(null, Buffer.concat(chunks)))
              payload.on('error', done)
            })

            routeFn(innerServer, routeDef)
          })
          continue
        }

        // BodyAsStream
        if (route.bodyAs === 'stream') {
          server.register(async innerServer => {
            innerServer.removeAllContentTypeParsers()
            innerServer.addContentTypeParser('*', function (_request, payload, done) {
              done(null, Readable.toWeb(payload))
            })

            routeFn(innerServer, routeDef)
          })
          continue
        }

        routeFn(server, routeDef)
      }
    },
    { prefix: router.prefix },
  )
}

/** Whether a request signal was aborted by Fastify's handler timeout, rather than by the client leaving. */
function isHandlerTimeout(reason: unknown): boolean {
  return (reason as { code?: unknown } | null)?.code === 'FST_ERR_HANDLER_TIMEOUT'
}

/** Joins a router base path and a route path, trimming a trailing slash (but never to empty). */
function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}
