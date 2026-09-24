import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, Server } from 'node:http'

import { Container, Scopes } from '@caffeinejs/di'
import { ConfigStore } from '@caffeinejs/std/config'
import type { Logger } from '@caffeinejs/std/logger'
import type { CookieSerializeOptions } from '@fastify/cookie'
import Fastify, {
  LogController,
  type FastifyHttpOptions,
  type FastifyInstance,
  type FastifyListenOptions,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import fp from 'fastify-plugin'

import type {
  Adapter,
  AdapterExtensionEntry,
  AdapterExtensions,
  AdapterFactory,
  AdapterFactoryIn,
  AdapterIn,
  AdapterTypes,
  ContextPlatform,
  ServerAddress,
} from './adapter.js'
import { CONSTRAINTS_PLUGIN, kRouteConstraints } from './constraints/constraints.js'
import { ErrApplicationNotReady, ErrConfiguration } from './error/common.js'
import { GlobalErrorHandlerRef } from './error/plugin.js'
import { solutions } from './error/util.js'
import { FastifyContext } from './fastify_context.js'
import { installFormBodyParser } from './form/index.js'
import { installFastifyMiddlewares, type FastifyMiddlewareHook } from './middleware/fastify.js'
import { pluginName, type AnyFastifyPlugin, type FastifyExtension } from './plugin.js'
import { RouteGroupBuilder } from './routing/builder.js'
import { installNotFoundHandler } from './routing/fastify/not_found.js'
import { compileArgs, compileHandler } from './routing/fastify/parameters.js'
import {
  assertFastifyPlugin,
  assertPluginNotRegistered,
  registerCompiledRouteGroup,
  resolveExtension,
} from './routing/fastify/register.js'
import type { CaffeineRouteConfig } from './routing/fastify/route_config.js'
import type { RouteCompilers, RouteGroup } from './routing/route.js'
import { assertAuthorizationConfigured } from './security/authz/index.js'
import { assertAuthenticationConfigured, type Principal } from './security/index.js'
import { Keys } from './symbols.js'

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
  extension: FastifyExtension
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

declare module './adapter.js' {
  interface AdapterRegistry {
    fastify: FastifyTypes
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    get $container(): Container
    $route(name: string, build: (router: RouteGroupBuilder) => void): void
  }

  interface FastifyRequest {
    httpContext: FastifyContext
    routeTarget: Record<string | symbol, (...args: unknown[]) => unknown> | null
    user: Principal
  }

  interface RawRequest {
    [Keys.CONTEXT]: FastifyContext
  }

  interface FastifyContextConfig {
    /**
     * What Caffeine compiled for the route, and what the authentication gate does with it.
     *
     * Stamped by the adapter onto every route its server registers, so a plugin's `onRoute` hook tells a
     * compiled route from one registered straight on Fastify by {@link CaffeineRouteConfig.compiled}, not by
     * this field's presence.
     */
    $caffeine?: CaffeineRouteConfig
  }
}

/**
 * The name `@caffeinejs/caching` registers its plugin under.
 *
 * The one place this package names another: `@CacheControl` / `@CacheInvalidate` and the plugin that serves them
 * ship together, so a route carrying the config with no plugin to read it is a missing `.with(HTTPCaching())`
 * and nothing else.
 */
const CACHING_PLUGIN = '@caffeinejs/caching'

export class FastifyAdapter implements Adapter<FastifyTypes> {
  /**
   * The parameter compilers handed to every route's dispatch, built once for the whole server. The reply type
   * a source sees is opaque, so the two are re-typed here rather than in the neutral contract.
   */
  readonly #compilers: RouteCompilers<FastifyRequest> = {
    handler: (parameters, fn) =>
      compileHandler<FastifyRequest, FastifyReply>(parameters, fn) as (req: FastifyRequest, res: unknown) => unknown,
    args: parameters =>
      compileArgs<FastifyRequest, FastifyReply>(parameters) as (
        req: FastifyRequest,
        res: unknown,
      ) => unknown[] | Promise<unknown[]>,
  }

  /** Built in {@link setup}; there is no server before that. */
  #fastify: FastifyInstance | undefined
  /** The `listener` section `.server(...)` returned, copied. `undefined` when none was given. */
  #listener: FastifyListenOptions | undefined
  #container: Container
  readonly #fastifyCtxAls = new AsyncLocalStorage<FastifyContext>()

  constructor(kit: AdapterFactoryIn) {
    this.#container = kit.container
    this.#container.bind(FastifyContext, t =>
      t
        .toFactory(() => this.#fastifyCtxAls.getStore()!)
        .lifetime(Scopes.REQUEST)
        .byPassPostProcessors()
        .internal(),
    )
  }

  /**
   * Listens with the options `run(...)` was given merged over the `listener` section `.server(...)` returned,
   * the former winning key by key. With neither, Fastify's own default applies.
   */
  async run(options?: FastifyListenOptions): Promise<void> {
    const fastify = this.#server()

    // Fastify defaults `localhost` and an OS-assigned port only for an absent argument: `listen({})` is refused
    // by Node, which wants a port or a path.
    if (this.#listener === undefined && options === undefined) {
      await fastify.listen()
      return
    }

    // A fresh object every call: `listen()` writes into what it is handed.
    await fastify.listen({ ...this.#listener, ...options })
  }

  async setup(input: AdapterIn<FastifyTypes>): Promise<void> {
    const container = this.#container
    // Copied, not aliased: `$route` appends to this, and `input.routeGroups` is the very array
    // `WebApplication.routeGroups` hands out — a push would publish a plugin's route as the application's.
    const routeGroups = [...input.routeGroups]

    // Built here and not when the adapter was: Fastify reads its logger while it constructs and exposes no setter
    // afterwards, and the configured logger exists only once every feature has configured.
    const { factory = {}, listener } = input.server
    const fastify = Fastify(withApplicationLogger(factory, input.context.logger))
    this.#fastify = fastify

    // Copied and read once: `listen()` writes into what it is handed, a live configuration node refuses that, and
    // the address has to stop moving once the socket is bound.
    this.#listener = listener === undefined ? undefined : { ...listener }

    // Ahead of `customize` below, and it is the one thing that is: Fastify runs `onRoute` synchronously as a
    // route is declared, so a raw route written in a customizer would otherwise register unstamped and the gate
    // would read it as a URL nothing matched. `??=` throughout — a compiled route and an `authenticationExempt()`
    // one arrive carrying their own.
    fastify.addHook('onRoute', route => {
      const config = (route.config ??= {})
      config.$caffeine ??= { skipAuthentication: false }
    })

    // The application's turn on the bare server, ahead of everything else this adapter decorates, hooks or
    // registers: a plugin registered here loads before every feature's, and a not-found handler set here is kept.
    await input.customize?.(fastify)

    // Decorating the server
    fastify.decorate('$container', container)

    // Decorating the request
    fastify.decorateRequest<Principal | null>('user', null)
    fastify.decorateRequest('routeTarget', null)
    fastify.decorateRequest('httpContext', null as unknown as FastifyContext)

    // One lookup for the whole server: each context takes its own snapshot off the store, on first read.
    const store = container.get(ConfigStore)

    fastify.addHook('onRequest', (req, reply, done) => {
      req.httpContext = new FastifyContext(req, reply, store)

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
      routeGroups.push(input.compileRouteGroup(builder.toRouteGroup<FastifyRequest>(), { name }))
    })

    // Every plugin the factories produced and every feature's server hook, in the order the application
    // installed them — this package's own included. Registered one at a time and awaited, so a plugin sees what
    // the one before it decorated. A plugin wrapped in `fastify-plugin` lands on this instance and therefore
    // covers every route; an unwrapped one keeps what it registers to itself. That is the plugin author's call,
    // not this loop's. `$route` (above) is what a plugin in this loop calls to add one more route. The form body
    // parser goes first, so every plugin registers onto a server that has it.
    installFormBodyParser(fastify)

    for (const entry of input.extensions.root()) {
      const { plugin, options } =
        entry.kind === 'feature' ? { plugin: featurePlugin(entry), options: {} } : resolveExtension(entry.extension)
      assertFastifyPlugin(plugin)
      assertPluginNotRegistered(fastify, plugin)
      await fastify.register(plugin, options)
    }

    // After every plugin, so one that took the not-found handler keeps it.
    installNotFoundHandler(fastify)

    // Installed by the error-handling plugin above; read back here because each route group's own
    // encapsulated handler resolves to it last.
    const globalErrorHandler = container.get(GlobalErrorHandlerRef).handler

    // Installed after the plugins so the hooks run inside a server that already has its error handler.
    installFastifyMiddlewares(fastify, input.middlewares.resolve(input.context))

    // Every plugin has had its turn, so whatever `$route` compiled is in `routeGroups` and the two scans see
    // the same table the registration loop below reads.
    assertAuthenticationConfigured(container, routeGroups)
    assertAuthorizationConfigured(container, routeGroups)
    assertRouteFeaturesInstalled(fastify, routeGroups, input.extensions)

    // The same for every group, so it is built once here rather than per registration.
    const registration = {
      extensions: input.extensions,
      compilers: this.#compilers,
      globalErrorHandler,
      handlerTimeout: factory.handlerTimeout,
    }

    for (const router of routeGroups) {
      registerCompiledRouteGroup(fastify, router, registration)
    }

    await fastify.ready()
  }

  // Both tolerate a server that was never built: `close()` runs `stop()` whether or not `ready()` got that far.
  async teardown(): Promise<void> {
    await this.#fastify?.close()
  }

  /**
   * Cuts the sockets `close()` is still waiting on, including keep-alive connections that are idle but not yet
   * expired. Called only once the shutdown budget is spent, so the pending `close()` can settle instead of being
   * interrupted mid-request by the orchestrator.
   */
  forceTeardown(): Promise<void> {
    this.#fastify?.server.closeAllConnections()
    return Promise.resolve()
  }

  get instance(): FastifyInstance {
    return this.#server()
  }

  get address(): ServerAddress | undefined {
    const bound = this.#fastify?.server.address()

    // `undefined` before the server is built; `null` when nothing is listening; a string when bound to a unix
    // socket or a named pipe, which has no host/port to report.
    if (bound == null || typeof bound === 'string') {
      return undefined
    }

    return { host: bound.address, port: bound.port, origin: originOf(bound.address, bound.port) }
  }

  /** @throws ErrApplicationNotReady before {@link setup} built the server. */
  #server(): FastifyInstance {
    if (this.#fastify === undefined) {
      throw new ErrApplicationNotReady()
    }

    return this.#fastify
  }

  async fetch(input: string | URL | Request, options?: RequestInit): Promise<Response> {
    const fastify = this.#server()
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
      fastify.inject(
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
 * The Fastify adapter, which builds its own instance at `ready()` from what `.server(...)` returned. It is what
 * `createWebApplication()` runs on when no adapter is named.
 */
export function fastifyAdapterFactory(): AdapterFactory<FastifyTypes> {
  return kit => new FastifyAdapter(kit)
}

/**
 * The application's configured logger becomes the server's, with request logging off, unless the factory
 * settings name a logger of their own. Fastify refuses `logger` and `loggerInstance` together, so a `logger` set
 * there is passed through untouched — request logging included, since that is then Fastify's default and not
 * this adapter's.
 *
 * Annotated rather than inferred on purpose: `loggerInstance` typed as the application's logger would make
 * `Fastify()` infer its logger parameter from it, and the instance would no longer be a plain `FastifyInstance`.
 */
function withApplicationLogger(factory: FastifyHttpOptions<Server>, logger: Logger): FastifyHttpOptions<Server> {
  if (factory.logger !== undefined || factory.loggerInstance !== undefined) {
    return factory
  }

  return {
    ...factory,
    loggerInstance: logger,
    logController: factory.logController ?? new LogController({ disableRequestLogging: true }),
  }
}

/**
 * A feature's server hook, as the plugin its slot registers.
 *
 * Wrapped in `fastify-plugin`, so the hook is handed the root server itself and what it adds covers every route.
 * Being a plugin is also what holds the next slot back until the hook, and whatever it registered without awaiting,
 * has loaded.
 */
function featurePlugin<S extends FastifyInstance>(
  entry: Extract<AdapterExtensionEntry<S, unknown>, { kind: 'feature' }>,
): FastifyPluginAsync {
  return fp(
    async (instance: FastifyInstance) => {
      // The root server is the one this adapter drives, so it is the caller's own server type.
      await entry.install(instance as S)
    },
    { name: `@caffeinejs/http:feature:${entry.name}` },
  )
}

/**
 * Refuses what the application declared and no installed feature can serve, as a start-up failure rather than
 * a route that quietly never does what its decorator says.
 *
 * Caching may be installed on the root server or on one route group, so each group is asked on its own: a
 * plugin one group installed does not serve its sibling.
 *
 * @throws ErrConfiguration when a route carries `@CacheControl` / `@CacheInvalidate` or a constraint and the
 *   plugin that serves it is not registered.
 */
function assertRouteFeaturesInstalled(
  server: FastifyInstance,
  routeGroups: readonly RouteGroup<any>[],
  extensions: Pick<AdapterExtensions<unknown, FastifyExtension>, 'of'>,
): void {
  if (!server.hasPlugin(CACHING_PLUGIN)) {
    for (const group of routeGroups) {
      const cached = group.routes.some(
        route => route.config?.has('cache') === true || route.config?.has('cacheInvalidate') === true,
      )
      const installed = (group.scopes ?? []).some(scope =>
        extensions.of(scope).some(extension => {
          const { plugin } = resolveExtension(extension)
          return typeof plugin === 'function' && pluginName(plugin as AnyFastifyPlugin) === CACHING_PLUGIN
        }),
      )

      if (cached && !installed) {
        throw new ErrConfiguration(
          'Cannot register routes decorated with @CacheControl or @CacheInvalidate: the caching plugin is not installed' +
            solutions(
              'Add ".with(HTTPCaching(...))" to the application builder',
              'Install it on the route group with ".plugin(HTTPCaching(...))" or "@Use(HTTPCaching(...))"',
            ),
        )
      }
    }
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
