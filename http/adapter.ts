import './_fastify.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable } from 'node:stream'

import { Container, Ctor, Scopes } from '@caffeinejs/di'
import { Configuration } from '@caffeinejs/std/config'
import {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyPluginCallback,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerBase,
} from 'fastify'

import { compileArgs, compileHandler } from './adapter_handler_parameters.js'
import type { Adapter, AdapterIn, AdapterFactoryIn } from './application.js'
import { constraintVaryPlugin } from './constraints/vary_plugin.js'
import { FastifyContext } from './context.js'
import { kBodyBuffer, kBodyStream } from './decorators/keys/keys.js'
import { ErrCaffeineWebApplication, ErrConfiguration } from './error/common.js'
import {
  GlobalErrorHandlerRef,
  installRouteGroupErrorHandler,
  type GlobalErrorHandler,
} from './error/error_handling.js'
import { solutions } from './error/util.js'
import { installFormBodyParser } from './form/index.js'
import { attachGuardHook } from './guards/attach.js'
import { joinPaths } from './internal/paths/index.js'
import { installNotFoundHandler } from './not_found.js'
import { pluginName } from './plugin.js'
import { Responder } from './response.js'
import type { RouteGroup } from './route.js'
import { type AdapterRouteOptions } from './route_hooks.js'
import { RouteGroupBuilder } from './routing/builder.js'
import type { RouteCompilers } from './routing/dispatch.js'
import type { RouteGroupSpec } from './routing/spec.js'
import { compileRouteSchema } from './schema/compile_route_schema.js'
import { assertAuthenticationConfigured, type Principal } from './security/index.js'
import { DEFAULT_SERVER_OPTIONS, ServerOptions, kServerOptions, type ServerAddress } from './server/index.js'
import { Keys } from './symbols.js'

/**
 * The name `@caffeinejs/caching` registers its plugin under.
 *
 * The one place this package names another: `@Cache` and the plugin that serves it ship together, so a route
 * carrying the config with no plugin to read it is a missing `.with(HTTPCaching())` and nothing else.
 */
const CACHING_PLUGIN = '@caffeinejs/caching'

/** The `onRequest` hook shape Fastify takes, which is the one a route source builds its group hook in. */
type OnRequestHook = (req: FastifyRequest, res: FastifyReply, done: (err?: Error) => void) => void

export class FastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> implements Adapter<SERVER, REQ> {
  /**
   * The parameter compilers handed to every route's dispatch, built once for the whole server. The reply type
   * a source sees is opaque, so the two are re-typed here rather than in the neutral contract.
   */
  readonly #compilers: RouteCompilers<REQ> = {
    handler: (parameters, fn) => compileHandler<REQ, RES>(parameters, fn) as (req: REQ, res: unknown) => unknown,
    args: parameters => compileArgs<REQ, RES>(parameters) as (req: REQ, res: unknown) => unknown[] | Promise<unknown[]>,
  }

  #fastify: SERVER
  #container: Container
  #serverOptions: ServerOptions = DEFAULT_SERVER_OPTIONS
  readonly #fastifyCtxAls = new AsyncLocalStorage<FastifyContext>()

  constructor(kit: AdapterFactoryIn, fastify: SERVER) {
    this.#fastify = fastify
    this.#container = kit.container
    this.#container.bind(FastifyContext, t =>
      t
        .toFactory(() => this.#fastifyCtxAls.getStore()!)
        .lifetime(Scopes.REQUEST)
        .byPassPostProcessors()
        .internal(),
    )
  }

  async run(): Promise<void> {
    await this.#fastify.listen(this.#serverOptions)
  }

  async setup(input: AdapterIn<REQ>): Promise<void> {
    const container = this.#container
    const routeGroups = input.routeGroups as RouteGroup<REQ>[]
    const fastify = this.#fastify

    // Decorating the server
    fastify.decorate('$container', container)

    // Decorating the request
    fastify.decorateRequest<Principal | null>('user', null)
    fastify.decorateRequest('routeTarget', null)
    fastify.decorateRequest('httpContext', null as unknown as FastifyContext)

    // One resolution for the whole server: each context takes its own snapshot off it, on first read.
    const configuration = container.get(Configuration)

    // Copied out of the live settings: `listen()` mutates what it is handed, and the address has to stop
    // moving once the socket is bound. An application that never registered the server feature runs on the
    // defaults.
    this.#serverOptions = { ...(container.getOptional(kServerOptions) ?? DEFAULT_SERVER_OPTIONS) }

    fastify.addHook('onRequest', (req, reply, done) => {
      req.httpContext = new FastifyContext(req, reply, configuration)

      Object.defineProperty(req.raw, Keys.CONTEXT, {
        value: req.httpContext,
        writable: false,
        configurable: false,
      })

      done()
    })

    if (container.hasRequestScoped) {
      const man = container.requestScopeManager
      fastify.addHook('onRequest', (req, reply, done) => {
        this.#fastifyCtxAls.run(req.httpContext, () => {
          man
            .run(
              () =>
                new Promise<void>(resolve => {
                  reply.raw.once('close', () => resolve())
                  done()
                }),
            )
            .catch((err: unknown) => req.log.error({ err }, 'Cannot tear down the request scope'))
        })
      })
    }

    const plugins = input.plugins
    const compilers = this.#compilers

    // Accumulated by `$route` while plugins register (right below) and compiled once, after that loop
    // finishes, into `allRouteGroups` — see there. A pure snapshot at push time: `.toRouteGroup()` reads the
    // builder's fields into a plain spec, no compiling, so this costs nothing beyond the array push itself.
    const lateRoutes: Array<{ name: string; spec: RouteGroupSpec<REQ> }> = []

    // Lets a plugin registered through the `.with(...)` loop right below add one more route, protectable the
    // same way any other route is — through the exact compiler `buildRouting()` already built
    // (`input.compileRouteGroup`), applied a second time below, once every plugin has had its turn. Nothing
    // is compiled here: the group only exists once `allRouteGroups` is built, after the plugin loop.
    //
    // Registration always targets this root instance, regardless of which context's `instance` the calling
    // plugin was handed — a decoration is visible down the prototype chain to any child context.
    fastify.decorate('$route', (name: string, build: (router: RouteGroupBuilder) => void) => {
      const builder = new RouteGroupBuilder()
      build(builder)
      lateRoutes.push({ name, spec: builder.toRouteGroup<REQ>() })
    })

    // Turns one `RouteGroup` into real Fastify routes: schema compilation, per-route config assembly, guard
    // attachment, the `BodyAsBuffer`/`BodyAsStream` content-type-parser swap.
    const registerCompiledRouteGroup = (router: RouteGroup<REQ>, globalErrorHandler: GlobalErrorHandler): void => {
      const basePath = router.path
      const routes = router.routes

      fastify.register(
        async server => {
          installRouteGroupErrorHandler(server, router, globalErrorHandler)

          // What a mounted router or a controller installed with `.plugin(...)` / `@Use(...)`. The same
          // plugin as an application-level one, registered in this group's context instead of on the root
          // server — so a `fastify-plugin`-wrapped plugin covers this group's routes and no others.
          for (const scope of router.scopes ?? []) {
            for (const plugin of plugins.of(scope)) {
              assertPluginNotRegistered(server, plugin)
              await server.register(plugin)
            }
          }

          // Whatever preparation the source that built this group needs — resolving the instance a `@Catch`
          // method will run on, for one. Registered as given, so it costs what the hook it replaces cost.
          if (router.onRequest !== undefined) {
            server.addHook('onRequest', router.onRequest as OnRequestHook)
          }

          for (const route of routes) {
            // Built here, once. The source decides *how* the route is invoked — a method on a singleton, one
            // resolved per request, a plain function — and hands back the function to install.
            const handle = route.dispatch(compilers) as (req: REQ, res: RES) => unknown

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

            config.$caffeine = {
              route,
              group: router,
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
              target: router.target,
              handler: route.name,
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
                const config = req.routeOptions.config.$caffeine

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

                const result = handle(req as REQ, res as RES)

                if (result instanceof Responder) {
                  return result.respond(req.httpContext)
                }

                if (result instanceof Promise) {
                  return result.then(r => {
                    if (r instanceof Responder) {
                      return r.respond(req.httpContext)
                    }

                    if (r === undefined) {
                      res.send()
                      return
                    }

                    return r
                  })
                }

                if (result === undefined) {
                  res.send()
                  return
                }

                return result
              },
            }

            const routeFn = (s: typeof server, def: AdapterRouteOptions) =>
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
            if (route.extras?.get(kBodyBuffer)) {
              server.register(async innerServer => {
                innerServer.removeAllContentTypeParsers()
                innerServer.addContentTypeParser(
                  '*',
                  { bodyLimit: route.bodyLimit },
                  function (_request, payload, done) {
                    const chunks: Buffer[] = []
                    payload.on('data', (chunk: Buffer) => chunks.push(chunk))
                    payload.on('end', () => done(null, Buffer.concat(chunks)))
                    payload.on('error', done)
                  },
                )

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
        },
        { prefix: router.prefix },
      )
    }

    // Every plugin the features contributed, in the order their features were installed — this package's own
    // included. Registered one at a time and awaited, so a plugin sees what the one before it decorated. A
    // plugin wrapped in `fastify-plugin` lands on this instance and therefore covers every route; an
    // unwrapped one keeps what it registers to itself. That is the plugin author's call, not this loop's.
    // `$route` (above) is what a plugin in this loop calls to accumulate one more route. The form body parser
    // and the constraint `Vary` header go first, so every plugin registers onto a server that has them.
    installFormBodyParser(fastify)
    await fastify.register(constraintVaryPlugin)

    for (const plugin of plugins.root()) {
      assertPluginNotRegistered(fastify, plugin)
      await fastify.register(plugin)
    }

    // After every plugin, so one that took the not-found handler keeps it.
    installNotFoundHandler(fastify)

    // Installed by the error-handling plugin above; read back here because each route group's own
    // encapsulated handler resolves to it last.
    const globalErrorHandler = container.get(GlobalErrorHandlerRef).handler

    // Installed after the plugins so the hooks run inside a server that already has its error handler.
    input.middlewares.install(fastify, container, configuration)

    // Every plugin has had its turn, so whatever `$route` accumulated is everything there is — compiled here,
    // once, through the identical compiler `buildRouting()` used for every other route, and folded into the
    // same table the checks below and the registration loop read. A plugin sees these routes the way it sees
    // every other: through `onRoute`, as they register.
    const allRouteGroups: RouteGroup<REQ>[] =
      lateRoutes.length === 0
        ? routeGroups
        : [
            ...routeGroups,
            ...lateRoutes.map(({ name, spec }) => input.compileRouteGroup(spec, { name, target: LateRouteGroup })),
          ]

    // What the application declared and no installed feature can serve. Both are start-up failures rather
    // than a route that quietly never does what its decorator says.
    assertAuthenticationConfigured(container, allRouteGroups)

    if (
      !fastify.hasPlugin(CACHING_PLUGIN) &&
      allRouteGroups.some(group =>
        group.routes.some(
          route => route.config?.has('cache') === true || route.config?.has('cacheInvalidate') === true,
        ),
      )
    ) {
      throw new ErrConfiguration(
        'Routes are decorated with @Cache or @CacheInvalidate but the caching feature is not installed: ' +
          'add ".with(HTTPCaching())" to the application builder',
      )
    }

    for (const router of allRouteGroups) {
      registerCompiledRouteGroup(router, globalErrorHandler)
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

  get address(): ServerAddress | undefined {
    const bound = this.#fastify.server.address()

    // `null` when nothing is listening; a string when bound to a unix socket or a named pipe, which has no
    // host/port to report.
    if (bound === null || typeof bound === 'string') {
      return undefined
    }

    return { host: bound.address, port: bound.port, origin: originOf(bound.address, bound.port) }
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
      this.#fastify.inject(
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
          const nullBody =
            result.statusCode < 200 ||
            result.statusCode === 204 ||
            result.statusCode === 205 ||
            result.statusCode === 304

          resolve(
            new Response(nullBody ? null : result.rawPayload, {
              status: result.statusCode,
              statusText: result.statusMessage,
              headers: responseHeaders,
            }),
          )
        },
      )
    })
  }
}

/** The synthetic target a `$route`-registered group compiles with, so a guard failure names something readable. */
class LateRouteGroup {}

/**
 * Refuses a second `fastify-plugin`-wrapped plugin of the same name before Fastify ever sees it.
 *
 * Fastify has no such check itself: a plugin factory is never deduplicated (two calls means two plugins, by
 * design), but a first-party plugin (`cors`, `html`, `caching`, …) wraps a fixed name, and a second one on the
 * same server would otherwise fail deep inside whatever it decorates — `@fastify/cors` re-declaring a request
 * decorator, tens of seconds later, once avvio's own boot timeout gives up waiting on it.
 */
function assertPluginNotRegistered(
  instance: FastifyInstance,
  plugin: FastifyPluginCallback | FastifyPluginAsync,
): void {
  const name = pluginName(plugin)

  if (name !== undefined && instance.hasPlugin(name)) {
    throw new ErrCaffeineWebApplication(
      `Cannot register plugin "${name}": it is already registered` +
        solutions(`Extend "${name}" once, or give the factory that produces it a different name`),
      'ERR_HTTP_DUPLICATE_PLUGIN',
    )
  }
}

/**
 * `0.0.0.0` and `::` are addresses to accept connections on, not addresses to dial, so an origin built from
 * them is not reliably reachable. Both map to their loopback equivalent; IPv6 is bracketed.
 */
function originOf(host: string, port: number): string {
  if (host === '0.0.0.0') {
    return `http://127.0.0.1:${port}`
  }

  if (host === '::' || host === '::1') {
    return `http://[::1]:${port}`
  }

  return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`
}
