import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, Server, ServerOptions } from 'node:http'
import type { SecureServerOptions } from 'node:http2'
import type { ServerOptions as HTTPSServerOptions } from 'node:https'
import type { Socket } from 'node:net'
import { Server as TLSServer } from 'node:tls'

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
  type FastifyPluginCallback,
  type FastifyPluginOptions,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
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
import { kRawBasePath, stripBasePath, type BasePathCarrier } from './base_path.js'
import { CONSTRAINTS_PLUGIN, kRouteConstraints } from './constraints/constraints.js'
import { ErrApplicationNotReady, ErrCaffeineWebApplication, ErrConfiguration } from './error/common.js'
import { GlobalErrorHandlerRef } from './error/plugin.js'
import { solutions } from './error/util.js'
import { FastifyContext } from './fastify_context.js'
import { installFormBodyParser } from './form/index.js'
import { installFastifyMiddlewares, type FastifyMiddlewareHook } from './middleware/fastify.js'
import { pluginName, type AnyFastifyPlugin, type FastifyExtension } from './plugin.js'
import { RouteGroupBuilder } from './routing/builder.js'
import { installNotFoundHandler } from './routing/fastify/not_found.js'
import { compileArgs, compileHandler } from './routing/fastify/parameters.js'
import { registerCompiledRouteGroup } from './routing/fastify/register.js'
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
   * logging off, unless `logger` or `loggerInstance` is set here.
   *
   * `https` serves TLS. `http2: true` serves HTTP/2: over TLS with `https`, which may also set `allowHTTP1`, and in
   * cleartext without it. The instance is typed `FastifyInstance` whichever server is built, so TLS can be switched
   * by configuration: narrow `instance.server` with `instanceof https.Server` to reach `setSecureContext`. Under
   * HTTP/2 the raw request and response are Node's `Http2ServerRequest` and `Http2ServerResponse`, still typed as
   * their HTTP/1 counterparts; narrow them with `instanceof` for what only HTTP/2 has, such as `stream`.
   */
  factory?: FastifyFactoryOptions

  /**
   * What `listen()` is called with. What `run(options)` is given is merged over it, key by key. With neither,
   * Fastify's own default applies (`localhost`, an OS-assigned port); a `host` without a `port` is refused by
   * Node, so write `port: 0` for an OS-assigned port.
   */
  listener?: FastifyListenOptions
}

/**
 * Fastify's constructor options with every server it can build: HTTP/1, HTTPS and HTTP/2. Fastify types each apart
 * by the server it returns, and the adapter's instance is one type whatever the server.
 */
type FastifyFactoryOptions = FastifyServerOptions<Server> & {
  http?: ServerOptions | null
  https?: HTTPSServerOptions | SecureServerOptions | null
  http2?: boolean
  http2SessionTimeout?: number
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
    /**
     * The application's `.basePath(...)`, or `''` when it set none. The server takes it off every request's path
     * before routing, so a plugin building, at start-up, a URL a browser will follow puts it in front.
     */
    get $basePath(): string
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
  /** What {@link forceTeardown} cuts on a server with no `closeAllConnections()`. `undefined` on one that has it. */
  #sockets: Set<Socket> | undefined
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
    // Fastify's HTTP/1 overload whatever `factory` asks for: the instance is one type whichever server it builds.
    const fastify = Fastify(
      withBasePath(withApplicationLogger(factory, input.context.logger), input.basePath) as FastifyHttpOptions<Server>,
    )
    this.#fastify = fastify

    // An HTTP/2 server has no `closeAllConnections()`, so the adapter keeps its connections for `forceTeardown()`.
    // `close()` ends HTTP/2 sessions only gracefully — Node's own and Fastify's `forceCloseConnections` alike
    // call `session.close()`, which waits for the streams still open — so a stream that overran the budget is
    // cut here or not at all. A socket is what an HTTP/2 session and an `allowHTTP1` connection both run on, and
    // destroying it ends either.
    if (typeof fastify.server.closeAllConnections !== 'function') {
      const sockets = new Set<Socket>()
      fastify.server.on('connection', (socket: Socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      this.#sockets = sockets
    }

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
    await input.customize?.(input.context, fastify)

    // Decorating the server
    fastify.decorate('$container', container)
    fastify.decorate('$basePath', input.basePath ?? '')

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
      await installExtension(fastify, entry.kind === 'feature' ? featurePlugin(entry) : entry.extension)
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
      installScope: async (server: FastifyInstance, scope: object): Promise<void> => {
        for (const extension of input.extensions.of(scope)) {
          await installExtension(server, extension)
        }
      },
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
    if (this.#sockets === undefined) {
      this.#fastify?.server.closeAllConnections()
    } else {
      for (const socket of this.#sockets) {
        socket.destroy()
      }
    }

    return Promise.resolve()
  }

  get instance(): FastifyInstance {
    return this.#server()
  }

  get address(): ServerAddress | undefined {
    const server = this.#fastify?.server
    const bound = server?.address()

    // `undefined` before the server is built; `null` when nothing is listening; a string when bound to a unix
    // socket or a named pipe, which has no host/port to report.
    if (server === undefined || bound == null || typeof bound === 'string') {
      return undefined
    }

    // Both HTTPS and HTTP/2 over TLS servers are TLS servers, whether `factory` or its `serverFactory` built them.
    const scheme = server instanceof TLSServer ? 'https' : 'http'

    return { host: bound.address, port: bound.port, origin: originOf(scheme, bound.address, bound.port) }
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
function withApplicationLogger(factory: FastifyFactoryOptions, logger: Logger): FastifyFactoryOptions {
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
 * Takes the application's base path off every request's path before Fastify routes it, and records what it took
 * on the raw request for `ctx.req.basePath`. A request without it is routed as it came.
 *
 * Returns the settings untouched when there is no base path, so an application without one pays nothing per
 * request. Fastify has saved the full URL in `request.originalUrl` before this runs, and a `rewriteUrl` the
 * application set itself runs after it, on the path the application sees.
 */
function withBasePath(factory: FastifyFactoryOptions, basePath: string | undefined): FastifyFactoryOptions {
  if (basePath === undefined) {
    return factory
  }

  const own = factory.rewriteUrl

  return {
    ...factory,
    rewriteUrl(req) {
      // A request a server received always has a URL: `url` is optional only because Node types the response a
      // client receives with the same class.
      const url = req.url!
      const stripped = stripBasePath(url, basePath)

      if (stripped !== undefined) {
        ;(req as typeof req & BasePathCarrier)[kRawBasePath] = basePath
        req.url = stripped
      }

      return own === undefined ? (stripped ?? url) : own.call(this, req)
    },
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
 * Registers what a factory produced on `server`, refusing what Fastify cannot register or already has.
 *
 * The one path every plugin takes — the application's, a router's, a controller's — so each is refused the same way.
 */
async function installExtension(server: FastifyInstance, extension: unknown): Promise<void> {
  const { plugin, options } = resolveExtension(extension)
  assertFastifyPlugin(plugin)
  assertPluginNotRegistered(server, plugin)
  await server.register(plugin, options)
}

/**
 * Splits what a factory produced into the plugin to register and the options to register it with.
 *
 * A Fastify plugin is a function and never an array, so the pair form is told apart by nothing else. The value
 * is still unchecked here — a controller's `@Use(...)` never met the application's type — so the caller asserts
 * on the plugin this hands back, not on what it was given.
 */
function resolveExtension(value: unknown): { plugin: unknown; options: FastifyPluginOptions } {
  return Array.isArray(value) ? { plugin: value[0], options: value[1] ?? {} } : { plugin: value, options: {} }
}

/**
 * Refuses anything but a plugin function, which is all Fastify can register.
 *
 * What reaches here from a controller's `@Use(...)` was never checked against the application's adapter, since a
 * decorator never meets the application's type.
 */
function assertFastifyPlugin(value: unknown): asserts value is AnyFastifyPlugin {
  if (typeof value !== 'function') {
    throw new ErrCaffeineWebApplication(
      `Cannot register an HTTP extension: expected a Fastify plugin, got ${typeof value}` +
        solutions('Return the plugin from the factory, or a [plugin, options] pair, not the object it configures'),
      'ERR_HTTP_INVALID_PLUGIN',
    )
  }
}

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
function originOf(scheme: 'http' | 'https', host: string, port: number): string {
  if (host === '0.0.0.0') {
    return `${scheme}://127.0.0.1:${port}`
  }

  if (host === '::' || host === '::1') {
    return `${scheme}://[::1]:${port}`
  }

  return host.includes(':') ? `${scheme}://[${host}]:${port}` : `${scheme}://${host}:${port}`
}
