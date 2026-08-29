import './_fastify.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/di'
import { type FastifyInstance, type FastifyReply, type FastifyRequest, type RawReplyDefaultExpression, type RawRequestDefaultExpression, type RawServerBase } from 'fastify'
import fp from 'fastify-plugin'
import type { Adapter, AdapterIn, AdapterFactoryIn } from './application.js'
import type { Router } from './route.js'
import type { Principal } from './security/index.js'
import { compileArgs, compileHandler } from './adapter_handler_parameters.js'
import { kBodyBuffer, kBodyStream } from './decorators/keys/keys.js'
import { ServerExtension, type ServerExtensionContext } from './server_extension.js'
import { ErrAuthenticationMiddlewareMissing } from './middleware/errors.js'
import { Authentication } from './security/auth/authentication_middleware.js'
import { installOIDCRoutes } from './security/auth/oidc/oidc_routes.js'
import { installFormBodyParser } from './form/index.js'
import { installGlobalErrorHandler, installRouterErrorHandler } from './error/error_handling.js'
import { installNotFoundHandler, NotFoundFallback } from './not_found.js'
import { type CacheDeps, type CacheOptions, attachCacheHooks, resolveCacheDeps } from './cache/cache.js'
import { type CacheInvalidateOptions, attachCacheInvalidateHook } from './cache/cache_invalidate.js'
import { installHealthProbes } from './health/index.js'
import { FastifyContext } from './context.js'
import { DEFAULT_SERVER_OPTIONS, ServerOptions } from './server/index.js'
import { Responder } from './response.js'
import { compileRouteSchema } from './schema/compile_route_schema.js'
import { joinPaths } from './internal/paths/index.js'
import { type AdapterRouteOptions } from './internal/route_hooks.js'
import { attachGuardHook } from './guards/attach.js'
import { kGuardOptions } from './guards/keys.js'

export class FastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> implements Adapter<SERVER, REQ> {
  #fastify: SERVER
  #container: Container
  #serverOptions: ServerOptions = DEFAULT_SERVER_OPTIONS
  readonly #fastifyCtxAls = new AsyncLocalStorage<FastifyContext>()

  constructor(
    kit: AdapterFactoryIn,
    fastify: SERVER,
  ) {
    this.#fastify = fastify
    this.#container = kit.container
    this.#container.bind(FastifyContext)
      .toFactory(() => this.#fastifyCtxAls.getStore()!)
      .lifetime(Scopes.REQUEST)
      .byPassPostProcessors()
      .internal()
  }

  async run(): Promise<void> {
    await this.#fastify.listen(this.#serverOptions)
  }

  async setup(input: AdapterIn<REQ>): Promise<void> {
    const container = this.#container
    const routers = input.routers as Router<REQ>[]
    const fastify = this.#fastify
    const services = input.services

    this.#serverOptions = services.server

    // Decorating the request
    fastify.decorateRequest<Principal | null>('user', null)
    fastify.decorateRequest('controller', null)
    fastify.decorateRequest('httpContext', null as unknown as FastifyContext)

    // Resolved here, ahead of everything else, because whether a middleware comes from request scope
    // decides which of the two context hooks below is installed. Their `setup()` runs later — after the
    // extensions, so a feature validating its own configuration reports before a middleware does.
    const middlewares = input.middlewares
    middlewares.resolveAll(container)

    if (container.hasRequestScoped) {
      const man = container.requestScopeManager
      fastify.addHook('onRequest', (req, reply, done) => {
        const ctx = new FastifyContext(req, reply)
        req.httpContext = ctx
        this.#fastifyCtxAls.run(ctx, () => man.run(() => done()))
      })
    } else {
      fastify.addHook('onRequest', (req, reply, done) => {
        req.httpContext = new FastifyContext(req, reply)
        done()
      })
    }

    const extensionContext: ServerExtensionContext = {
      server: fastify,
      container,
      services,
      routers,
    }

    // The built-in features. Plain calls in a stated order rather than a discovered list: they are this
    // package's own code, and nothing about them is pluggable.
    const globalErrorHandler = installGlobalErrorHandler(fastify, services.errorHandling)
    installFormBodyParser(fastify)
    installHealthProbes(extensionContext)
    installOIDCRoutes(extensionContext)

    // Extensions contributed by other packages, registered as real Fastify plugins so `dependencies`,
    // `decorators` and the version range are enforced by Fastify — and so each shows up by name in
    // `printPlugins()`. `fp` skips encapsulation, so an extension still decorates the root instance.
    for (const extension of container.getManyOptional<ServerExtension>(ServerExtension)) {
      await fastify.register(fp(
        // Async so a `configure` that throws synchronously becomes a rejection avvio can carry, rather than
        // escaping the plugin call and stalling the boot.
        async instance => {
          await extension.configure({ ...extensionContext, server: instance })
        },
        {
          name: extension.name,
          dependencies: extension.dependencies as string[] | undefined,
          decorators: extension.decorators,
          fastify: extension.fastify,
        },
      ))
    }

    // After the extensions, not up with the other built-ins: a fallback may be bound by an extension, and one
    // serving files needs the `reply.sendFile` that `@fastify/static` decorates while it registers.
    installNotFoundHandler(
      extensionContext,
      container.getManyOptional<NotFoundFallback>(NotFoundFallback),
    )

    await middlewares.setupAll(extensionContext)

    // The pipeline is explicit, which leaves exactly one way to disable every guard in the application:
    // forget to register the authentication middleware. An application that protects routes and then
    // serves them to anonymous callers must not start.
    const anyRouteNeedsAuthz = routers.some(r => r.routes.some(rt => rt.authorization.hasProtection))
    if (anyRouteNeedsAuthz && !middlewares.has(Authentication)) {
      throw new ErrAuthenticationMiddlewareMissing()
    }

    // Installed after the extensions so the hooks run inside a server that already has its error handler.
    middlewares.installHooks(fastify)

    // Resolved once, not per route and never per request. Unconditional, as the cache configurer's server
    // phase was: an application that binds a store gets it constructed at start-up either way.
    const cacheDeps: CacheDeps = resolveCacheDeps(container)

    for (const router of routers) {
      const basePath = router.path
      const routes = router.routes

      fastify.register(async server => {
        const controller = router.controller
        const isSingleton = router.binding.scopeID === Scopes.SINGLETON

        server.decorateRequest('responseCached', false)

        installRouterErrorHandler(server, router, globalErrorHandler)

        for (const route of routes) {
          let handle: (req: REQ, res: RES) => unknown

          if (router.errorHandlers?.size) {
            const pickArgs = compileArgs(route.parameters)
            const handlerKey = route.handler

            handle = async (req, res) => {
              const instance = req.controller!
              const args = await pickArgs(req, res)

              return (instance[handlerKey] as (...args: unknown[]) => unknown).apply(instance, args)
            }
          } else if (isSingleton) {
            const ref = controller.get()
            const refFn = (ref[route.handler] as (...args: unknown[]) => unknown).bind(ref)

            handle = compileHandler(route.parameters, refFn)
          } else {
            const handlerKey = route.handler

            handle = compileHandler(route.parameters, (...args) => {
              const ctrl = controller.get()
              return (ctrl[handlerKey] as (...args: unknown[]) => unknown).apply(ctrl, args)
            })
          }

          // The `handler` middleware group wraps the dispatch, so `next()` hands the middleware whatever
          // the controller returned. Returns the dispatch unchanged when nothing is registered there.
          const dispatch = middlewares.wrapHandler(handle)

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

          // Guard Options
          if (route.guardOptions) {
            const opts: Record<string | symbol, unknown> = {}
            for (const [k, v] of Object.entries(route.guardOptions)) {
              opts[k] = v
            }
            config[kGuardOptions] = opts
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

          config.caffeine = {
            hasStatus,
            status,
            hasContentType,
            contentType,
            hasHeader,
            header,
            catchBy: route.catchBy,
            // The authentication middleware is registered once, for the whole server, so what a route
            // declared has to travel with the route rather than be closed over per registration.
            auth: {
              schemes: route.authorization.options?.schemes,
              allowAnonymous: route.authorization.options?.allowAnonymous === true,
              authorizer: route.authorization.authorizer,
            },
            controller: typeof router.key === 'function' ? router.key : undefined,
            handler: route.handler,
          }

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
              const config = req.routeOptions.config.caffeine

              if (config.hasHeader) {
                for (let i = 0; i < config.header.length; i++) {
                  const item = config.header[i]
                  res.header(item[0], item[1])
                }
              }

              if (config.hasContentType) {
                res.type(config.contentType)
              }

              if (config.hasStatus) {
                res.code(config.status)
              }

              const result = dispatch(req as REQ, res as RES)

              if (result instanceof Responder) {
                return result.respond(req.httpContext)
              }

              if (result instanceof Promise) {
                return result.then(r => (r instanceof Responder ? r.respond(req.httpContext) : r))
              }

              return result
            },
          }

          const routeFn = (s: typeof server, def: AdapterRouteOptions) =>
            (s as FastifyInstance<
              RawServerBase,
              RawRequestDefaultExpression<RawServerBase>,
              RawReplyDefaultExpression<RawServerBase>
            >).route(def)

          // Cache, attached only to the routes that asked for it. A route with neither decorator leaves both
          // hook slots undefined and pays nothing.
          const cacheOpts = config.cache as CacheOptions | false | undefined
          if (cacheOpts !== undefined) {
            attachCacheHooks(routeDef, cacheOpts, cacheDeps)
          }

          const invalidateOpts = config.cacheInvalidate as CacheInvalidateOptions | false | undefined
          if (invalidateOpts !== undefined && invalidateOpts !== false) {
            attachCacheInvalidateHook(routeDef, invalidateOpts, cacheDeps.store)
          }

          if (route.guards !== undefined && route.guards.length > 0) {
            attachGuardHook(routeDef, route.guards)
          }

          // BodyAsBuffer
          // When the route is decorated with @BodyAsBuffer(), the body is read as a raw buffer.
          if (route.extras?.get(kBodyBuffer)) {
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
          if (route.extras?.get(kBodyStream)) {
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
      }, { prefix: router.prefix })
    }

    await fastify.ready()
  }

  async teardown(): Promise<void> {
    await this.#fastify.close()
  }

  /**
   * Cuts the sockets `close()` is still waiting on, including keep-alive connections that are idle but not yet
   * expired. Called only once the shutdown budget is spent, so the pending `close()` can settle instead of being
   * interrupted mid-request by the orchestrator.
   */
  forceTeardown(): Promise<void> {
    this.#fastify.server.closeAllConnections()
    return Promise.resolve()
  }

  get instance(): SERVER {
    return this.#fastify
  }

  async fetch(input: string | URL | Request, options?: RequestInit): Promise<Response> {
    let request: Request

    if (input instanceof Request) {
      request = input
    } else {
      if (typeof input === 'string') {
        if (input.startsWith('/')) {
          input = 'http://localhost' + input
        }
      }

      request = new Request(input, options)
    }

    const body = await request.arrayBuffer()
    const payload = body.byteLength > 0 ? Buffer.from(body) : undefined

    // light-my-request computes content-length from the payload itself;
    // passing the original value causes a mismatch
    request.headers.delete('content-length')

    return new Promise<Response>((resolve, reject) => {
      void this.#fastify.inject(
        {
          method: request.method as any,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          payload,
        },
        (err, result) => {
          if (err || !result) {
            reject(err ?? new Error('inject produced no result'))
            return
          }

          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(result.headers)) {
            if (value === undefined) {
              continue
            }

            if (Array.isArray(value)) {
              for (const v of value) {
                responseHeaders.append(key, String(v))
              }
            } else {
              responseHeaders.set(key, String(value))
            }
          }

          // Null-body statuses (204/205/304, plus 1xx) must be constructed with a null body, otherwise
          // the Response constructor throws "Invalid response status code".
          const nullBody = result.statusCode < 200
            || result.statusCode === 204
            || result.statusCode === 205
            || result.statusCode === 304

          resolve(new Response(nullBody ? null : result.rawPayload, {
            status: result.statusCode,
            statusText: result.statusMessage,
            headers: responseHeaders,
          }))
        },
      )
    })
  }
}
