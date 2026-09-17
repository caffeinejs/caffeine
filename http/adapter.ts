import './_fastify.js'
import { AsyncLocalStorage } from 'node:async_hooks'

import { Container, Scopes } from '@caffeinejs/di'
import { Configuration } from '@caffeinejs/std/config'
import { logToken } from '@caffeinejs/std/logger'
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import { assertPluginNotRegistered, registerCompiledRouteGroup } from './_register_route_group.js'
import { compileArgs, compileHandler } from './adapter_handler_parameters.js'
import type { Adapter, AdapterIn, AdapterFactoryIn } from './application.js'
import { CONSTRAINTS_PLUGIN, kRouteConstraints } from './constraints/constraints.js'
import { FastifyContext } from './context.js'
import { ErrConfiguration } from './error/common.js'
import { GlobalErrorHandlerRef } from './error/error_handling.js'
import { solutions } from './error/util.js'
import { installFormBodyParser } from './form/index.js'
import { installNotFoundHandler } from './not_found.js'
import type { RouteGroup } from './route.js'
import { RouteGroupBuilder } from './routing/builder.js'
import type { RouteCompilers } from './routing/dispatch.js'
import { assertAuthorizationConfigured } from './security/authz/index.js'
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
    // Copied, not aliased: `$route` appends to this, and `input.routeGroups` is the very array
    // `WebApplication.routeGroups` hands out — a push would publish a plugin's route as the application's.
    const routeGroups = [...(input.routeGroups as RouteGroup<REQ>[])]
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

    // Fastify derived its own child of the application's logger while it was constructed, and a child keeps the
    // level it was born with. Without this, a level the logger feature resolved — from configuration, after the
    // server existed — would govern every logger but the server's own.
    const log = container.getOptional(logToken())

    if (log !== undefined) {
      fastify.log.level = log.level
    }

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

    // Lets a plugin registered through the `.with(...)` loop right below add one more route, protectable the
    // same way any other route is. Compiled on the spot, through the exact compiler `buildRouting()` built
    // (`input.compileRouteGroup`), so a guard shared with an ordinary route resolves through the one cache
    // rather than a second one. Only registration waits: the group registers in the loop at the bottom with
    // every other one, which is what puts it in front of every plugin's `onRoute` hook whichever order the
    // plugins were installed in.
    //
    // Registration always targets this root instance, regardless of which context's `instance` the calling
    // plugin was handed — a decoration is visible down the prototype chain to any child context.
    fastify.decorate('$route', (name: string, build: (router: RouteGroupBuilder) => void) => {
      const builder = new RouteGroupBuilder()
      build(builder)
      routeGroups.push(input.compileRouteGroup(builder.toRouteGroup<REQ>(), { name }))
    })

    // Every plugin the features contributed, in the order their features were installed — this package's own
    // included. Registered one at a time and awaited, so a plugin sees what the one before it decorated. A
    // plugin wrapped in `fastify-plugin` lands on this instance and therefore covers every route; an
    // unwrapped one keeps what it registers to itself. That is the plugin author's call, not this loop's.
    // `$route` (above) is what a plugin in this loop calls to add one more route. The form body parser
    // goes first, so every plugin registers onto a server that has it.
    installFormBodyParser(fastify)

    for (const plugin of input.plugins.root()) {
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

    // Every plugin has had its turn, so whatever `$route` compiled is in `routeGroups` and the two scans see
    // the same table the registration loop below reads.
    assertAuthenticationConfigured(container, routeGroups)
    assertAuthorizationConfigured(container, routeGroups)
    assertRouteFeaturesInstalled(fastify, routeGroups)

    // The same for every group, so it is built once here rather than per registration.
    const registration = { plugins: input.plugins, compilers: this.#compilers, globalErrorHandler }

    for (const router of routeGroups) {
      registerCompiledRouteGroup(fastify, router, registration)
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

/**
 * Refuses what the application declared and no installed feature can serve, as a start-up failure rather than
 * a route that quietly never does what its decorator says.
 *
 * @throws ErrConfiguration when a route carries `@Cache` / `@CacheInvalidate` or a constraint and the plugin
 *   that serves it is not registered.
 */
function assertRouteFeaturesInstalled(server: FastifyInstance, routeGroups: readonly RouteGroup<any>[]): void {
  if (
    !server.hasPlugin(CACHING_PLUGIN) &&
    routeGroups.some(group =>
      group.routes.some(route => route.config?.has('cache') === true || route.config?.has('cacheInvalidate') === true),
    )
  ) {
    throw new ErrConfiguration(
      'Routes are decorated with @Cache or @CacheInvalidate but the caching feature is not installed: ' +
        'add ".with(HTTPCaching())" to the application builder',
    )
  }

  if (
    !server.hasPlugin(CONSTRAINTS_PLUGIN) &&
    routeGroups.some(group => group.routes.some(route => route.config?.has(kRouteConstraints) === true))
  ) {
    throw new ErrConfiguration(
      'Cannot register constrained routes: the constraints plugin is not installed' +
        solutions('Add ".with(() => constraints())" to the application builder'),
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
