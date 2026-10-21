import {
  Application,
  ErrApplicationNotReady,
  kAddConfigurer,
  type ApplicationOptions,
  type FeatureConfigurer,
  type RunInfo,
} from '@caffeinejs/application'
import { errMessage } from '@caffeinejs/std/err'

import {
  type IAdapter,
  type AdapterExtensionFactory,
  type AnyAdapterTypes,
  type AdapterFactory,
  type IAdapterServer,
  type IAdapterTypes,
  type HTTPSetupContext,
  type ServerAddress,
  type ServerConfigurer,
  type ServerCustomizer,
} from './adapter.js'
import { CookieBuilder } from './core/cookie/cookie.js'
import { ErrConfiguration } from './core/error/common.js'
import { ErrorHandlingBuilder } from './core/error/error.js'
import { listenerServers } from './core/listener/servers.js'
import {
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewareOptions,
  type MiddlewarePath,
  type MiddlewareResolvable,
  type MiddlewareTarget,
  type Next,
  type NodeMiddleware,
} from './core/middleware/index.js'
import { parseUse } from './core/middleware/middleware.js'
import { ControllerRouteSource } from './core/routing/decorated/decorated.js'
import { buildRouting, type RouteSource } from './core/routing/index.js'
import type { Router } from './core/routing/programmatic/programmatic.js'
import { ScopedPlugins } from './core/routing/programmatic/scoped_plugins.js'
import { FluentRouteSource } from './core/routing/programmatic/source.js'
import type { IRouteGroup } from './core/routing/route.js'
import { AuthorizationBuilder } from './core/security/authz/index.js'
import { getRouteGroup } from './decorators/registrar/registrar.js'
import type { HTTPPlugin } from './plugin.js'
import { assertPluginFactory } from './plugin_factory.js'
import { closedApplicationOps } from './plugin_slot.js'
import type { IServer } from './server.js'
import { ServerDefinition, type BasePathConfigurer } from './server_definition.js'
import { ServerSet } from './servers.js'
import { Keys } from './symbols.js'

/** {@link RunInfo} widened with where the HTTP server bound. */
export interface WebRunInfo extends RunInfo {
  /** Where the server is listening, from {@link WebApplication.address}. */
  readonly address: ServerAddress
}

export type WebApplicationOptions<TConfig = unknown> = ApplicationOptions<TConfig>

/**
 * The HTTP application: an {@link Application} whose lifecycle steps drive an {@link IAdapter}: Fastify's, through
 * `createWebApplication()` from `@caffeinejs/http/fastify`, or the one given to the constructor. `setup()` builds
 * routing and sets the adapter up; `start()` runs it; `stop()` tears it down. `Application` handles the container, features, and lifecycle hooks.
 *
 * Configures fluently, and is itself the running instance — there is no separate builder. Features (container
 * binders) are installed with `.install(...)`, in any order; server plugins are registered with `.with(...)`,
 * in the order that matters:
 *
 * ```ts
 * createWebApplication()
 *   .install(Authentication(auth => auth.addJWTBearer(b => b.secret(SECRET))))
 *   .with(authentication())
 *   .with(staticFiles(s => s.serve('public')))
 *   .server(() => ({ listener: { port: 3000 } }))
 * ```
 */
export class WebApplication<T extends IAdapterTypes = AnyAdapterTypes, ROUTES = never, DEPS = never, C = unknown>
  extends Application<C>
  implements IServer<T>
{
  /** Phantom — names the routes mounted on this application, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: ROUTES

  /** Phantom — names what the mounted routers injected, for `DepsOf`. Never assigned, never read. */
  declare readonly __deps?: DEPS

  readonly #adapter: IAdapter<T>
  /** What the application's own server is built from: what its fluent methods registered. */
  readonly #own = new ServerDefinition<T, C>()
  /** Every server, the application's own first, once {@link setup} has read them. */
  #servers: ServerSet<T> | undefined
  /** The listeners `Listener(...)` installed, once {@link setup} has built them. */
  #listeners: ReadonlyMap<string, IServer<T>> | undefined
  #runArgs: T['runArgs'] | undefined
  #routeGroups: IRouteGroup<T['request']>[] = []
  #mounted: Router<any, any, any, any, any, any>[] = []
  #built = false
  /** What routers and controllers registered for themselves, resolved once during start-up. */
  readonly #plugins = new ScopedPlugins<T>()

  // Held as fields: `.errorHandling(...)` and `.cookie(...)` hand their callbacks to the instances installed below.
  readonly #errorHandling = new ErrorHandlingBuilder<C>()
  readonly #cookieBuilder = new CookieBuilder<C>()

  constructor(adapterFactory: AdapterFactory<T>, options: WebApplicationOptions<C> = {}) {
    super(options)

    // Installed unconditionally, so their names are dedupe-protected and `$hasFeature` answers for them. The
    // order here is configure order only: each binds what its server half runs on, and the adapter installs those
    // halves ahead of everything `.with(...)` registers, error handling first, then cookies. Cookies are read lazily,
    // so no plugin that reads one has an order to get right, and the cookie writer's `onSend` hook leads every
    // later plugin's.
    this.install(this.#errorHandling)
    this.install(this.#cookieBuilder)

    // Graceful shutdown is `Application`'s own unconditional feature — inherited, not duplicated here.

    this.#adapter = adapterFactory({ container: this.container })
  }

  /**
   * The server the adapter built.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built it.
   */
  get instance(): T['instance'] {
    return this.#ownServer().instance
  }

  /**
   * Where the server is listening, or `undefined` until {@link run} has bound a socket. Reports what the
   * socket actually got, so it is the way to reach an application started on port `0`.
   */
  get address(): ServerAddress | undefined {
    return this.#servers?.own?.address
  }

  /**
   * The listeners `Listener(...)` installed, by name and in install order: empty when none was. Each one's `address`
   * is where to point a client at the routes bound to it.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built them.
   */
  get listeners(): ReadonlyMap<string, IServer<T>> {
    if (this.#listeners === undefined) {
      throw new ErrApplicationNotReady('reach the listeners')
    }

    return this.#listeners
  }

  /**
   * Every route group the application declared, compiled, whichever server serves it: the mounted routers' and the
   * controllers'. What a plugin adds, with `context.app.mount(...)` or `$route`, is not among them.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built them.
   */
  get routeGroups(): IRouteGroup<T['request']>[] {
    if (!this.started) {
      throw new ErrApplicationNotReady('read the route groups')
    }

    return this.#routeGroups
  }

  /** @throws ErrApplicationNotReady before {@link ready} has built the server. */
  async fetch(request: Request | string | URL, options?: RequestInit): Promise<Response> {
    return this.#ownServer().fetch(request, options)
  }

  /**
   * Adds a middleware to the request pipeline. Order matters, and it is the order these calls are written
   * in — within a hook.
   *
   * The first argument may be a path (`string` or `string[]`); `'*'` means every request. The middleware may
   * be a Node `(req, res, next)` function, a Caffeine `(ctx, next)` function, an instance, a class, or a
   * container key.
   *
   * Which hooks exist is the adapter's: under Fastify, a `MiddlewareHook`, defaulting to `onRequest`. A
   * Caffeine middleware may hint a different hook with {@link kMiddlewareHook}; `{ hook }` on this call
   * overrides that hint. Answer the request with `ctx.body()` and do not call `next`.
   *
   * ```ts
   * app.use(RequestLogger)
   * app.use('/admin', kRateLimiter, { hook: 'preHandler' })
   * ```
   *
   * A middleware naming the variables it writes is taken at its word: the routers it ends up in front of are
   * declared elsewhere, so nothing here checks that they declare the same ones.
   *
   * The pipeline runs on the application's own server alone. A listener has its own:
   * `Listener(name, l => l.use(...))`.
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<T['hook']>,
  ): this
  use(target: NodeMiddleware, options?: MiddlewareOptions<T['hook']>): this
  use(target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions<T['hook']>): this
  use(target: MiddlewareResolvable, options?: MiddlewareOptions<T['hook']>): this
  use<V = Record<never, never>, Conf = Record<never, never>>(
    path: MiddlewarePath,
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<T['hook']>,
  ): this
  use(path: MiddlewarePath, target: NodeMiddleware, options?: MiddlewareOptions<T['hook']>): this
  use(
    path: MiddlewarePath,
    target: (req: never, res: never, next: Next) => void,
    options?: MiddlewareOptions<T['hook']>,
  ): this
  use(path: MiddlewarePath, target: MiddlewareResolvable, options?: MiddlewareOptions<T['hook']>): this
  use(
    pathOrTarget: MiddlewarePath | MiddlewareTarget<C> | ((req: never, res: never, next: Next) => void),
    targetOrOptions?:
      | MiddlewareTarget<C>
      | MiddlewareOptions<T['hook']>
      | ((req: never, res: never, next: Next) => void),
    options?: MiddlewareOptions<T['hook']>,
  ): this {
    const parsed = parseUse<C, T['hook']>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#own.middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Adds a factory that builds middleware once at start-up from the configuration, container and logger.
   *
   * This is separate from {@link use} because both a factory and a Caffeine middleware are functions. The distinct
   * method keeps the factory's setup context inferred without weakening inference for `use`'s Caffeine and Node
   * middleware signatures.
   *
   * ```ts
   * app.useFn('*', ({ config }) => rateLimit(config.limits))
   * ```
   *
   * Like {@link use}, it reaches the application's own server and no listener.
   */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions<T['hook']>): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions<T['hook']>): this
  useFn(
    pathOrTarget: MiddlewarePath | MiddlewareFactory<C>,
    targetOrOptions?: MiddlewareFactory<C> | MiddlewareOptions<T['hook']>,
    options?: MiddlewareOptions<T['hook']>,
  ): this {
    const parsed = parseUse<C, T['hook']>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#own.middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Registers a server plugin from a factory — under Fastify, one producing a plugin or a `[plugin, options]`
   * pair. Plugins install on the application's own server, in the order these calls are written, after the
   * framework's own head slots (error handling, cookies):
   *
   * ```ts
   * createWebApplication()
   *   .with(staticFiles(s => s.serve('public')))
   *   .with(({ config }) => [fastifyCors, config.app.cors.options])
   *   .with(HTTPCaching(cache => cache.statusHeader('X-Edge')))
   * ```
   *
   * A listener installs none of them. It has its own: `Listener(name, l => l.with(...))`.
   *
   * A factory needing to configure its plugin hands the plugin back together with its options, rather than
   * wrapping it in one that closes over them: an official plugin already wraps itself in `fastify-plugin`, so
   * registering it directly is what puts its hooks on every route, while a wrapper would take an encapsulation
   * context of its own and cover nothing.
   *
   * A factory is never deduplicated — two calls register two plugins. A `fastify-plugin` name already on that
   * instance is refused at register time. A factory producing another adapter's extension does not compile.
   *
   * A factory may return an `HTTPPlugin` instead of a plugin, when it needs nothing from Fastify: its `register`
   * runs in this slot. Either kind of factory may mount routers on this server and add middleware to its pipeline
   * with `context.app`, which takes this application's adapter.
   *
   * A feature is not a plugin: install it with {@link Application.install}, at any position in the chain — a
   * feature binds into the container before any factory here runs, so only `.with(...)` order matters.
   *
   * @throws ErrApplicationStarted when {@link bootstrap} has already started.
   */
  with(factory: AdapterExtensionFactory<T['extension'] | HTTPPlugin<T>, C, T>): this {
    this.assertConfigurable()
    assertPluginFactory(factory)

    this.#own.plugins.push(factory)
    return this
  }

  /**
   * Auto-installs authorization when authentication was installed and `Authorization(...)` never was — so a
   * protected route still gets a default policy — after the {@link bootstrap} callback and before the base
   * class captures the feature list. Neither installed means authorization stays off, by design.
   */
  protected override beforeConfigure(): void {
    if (this.hasFeature('auth') && !this.hasFeature('authz')) {
      this.install(new AuthorizationBuilder())
    }
  }

  /**
   * Configures the server the adapter builds at {@link ready}: the application's own. A listener takes its
   * settings from `Listener(name, l => l.server(...))`.
   *
   * `configure` resolves against the same context a plugin factory gets and returns the adapter's own settings —
   * under Fastify `{ factory, listener }`, the constructor options and the listen options. To reach the server
   * itself, use {@link serverCallback}.
   *
   * Calls accumulate: the settings shallow-merge section by section in call order. A configuration node handed
   * over as a section is copied, never mutated.
   *
   * ```ts
   * .server(({ config }) => ({ listener: config.app.server }))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  server(configure: ServerConfigurer<T, C>): this {
    this.assertConfigurable()
    this.#own.server.push(configure)
    return this
  }

  /**
   * Hands `callback` the setup context and then the server the adapter builds at {@link bootstrap}, right after it
   * is constructed and before the adapter decorates or registers anything on it: a plugin registered here loads
   * ahead of every head slot and `.with(...)` plugin, and a not-found handler set here is kept. A listener is
   * never handed over.
   *
   * Calls accumulate and run in call order.
   *
   * ```ts
   * .serverCallback(({ logger }, instance) => instance.addHook('onRoute', r => logger.debug(r.url)))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  serverCallback(callback: ServerCustomizer<T, C>): this {
    this.assertConfigurable()
    this.#own.customizers.push(callback)
    return this
  }

  /**
   * Serves the whole application under `basePath`, for one placed behind a gateway or a proxy that forwards a
   * path prefix with the request. A listener is served from its root.
   *
   * The server takes the base off a request's path before routing, so everything the application declares stays
   * written as if it were served from the root: routes from any source, plugin routes such as the health probes,
   * `app.use(path, …)` paths and fallback-policy exceptions. `ctx.req.url` is that path, and `ctx.req.basePath`
   * is what was taken off. The redirects this package builds — a sign-in challenge, its return URL, a denied
   * access — add the base back; one a handler builds itself writes `ctx.req.basePath + '/somewhere'`.
   *
   * A request without the base is routed as it is, and its `ctx.req.basePath` is `''`. The base must end on a
   * segment boundary (`/api` matches `/api/pets`, never `/apix`) and is compared with the path as sent:
   * case-sensitively, and percent-encoded.
   *
   * `basePath` may be a callback, resolved once at {@link ready} against the same context `.server(...)` gets.
   * Resolving to `undefined`, `''` or `'/'` means no base path. The last call wins.
   *
   * ```ts
   * .basePath('/api')
   * .basePath(({ config }) => config.app.basePath)
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   * @throws ErrConfiguration from {@link ready}, when the base path does not start with a single "/" (never "//"
   *   or "/\"), or holds a "?", a "#" or a control character.
   */
  basePath(basePath: string | BasePathConfigurer<C>): this {
    this.assertConfigurable()
    this.#own.basePath = typeof basePath === 'string' ? () => basePath : basePath
    return this
  }

  /**
   * Configures the cookies every application gets: the secret or the signer signed cookies use, the defaults every
   * cookie starts from, and whether servers handle cookies at all. The feature is registered either way, so this
   * only overrides the defaults — and it is registered ahead of every plugin, so where in the chain the call is
   * written makes no difference.
   *
   * ```ts
   * .cookie((k, { config }) => k.config(config.app.cookie))
   * .cookie(k => k.secret([current, previous]))   // rotation: the first signs, either verifies
   * .cookie(k => k.signer(MyCookieSigner))        // a container key, resolved as each server starts
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  cookie(configure: FeatureConfigurer<CookieBuilder<C>, C>): this {
    this.assertConfigurable()
    this.#cookieBuilder[kAddConfigurer](configure)
    return this
  }

  /**
   * Enrols the application's global error handlers. The feature is registered either way and installs ahead of
   * every plugin, so where in the chain the call is written makes no difference, and an application that never
   * calls it still renders a thrown `ErrHTTP` as the default JSON envelope.
   *
   * A `@Catch` class renders errors application-wide only once it is named here. One nobody names stays bound
   * in the container, reachable through `@CatchWith` on a controller or route.
   *
   * ```ts
   * .errorHandling(e => e.globalHandlers(HTTPErrorHandler, FallbackErrorHandler))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  errorHandling(configure: FeatureConfigurer<ErrorHandlingBuilder<C>, C>): this {
    this.assertConfigurable()
    this.#errorHandling[kAddConfigurer](configure)
    return this
  }

  /** Resolves what each controller's `@Use(...)` asked for, keyed by its class. */
  async #controllerPlugins(context: HTTPSetupContext): Promise<void> {
    // Registered when the container compiled, so every controller the application can resolve is already known here.
    for (const { key } of this.container.getBindingsByLabel(Keys.CONTROLLER)) {
      if (typeof key === 'function') {
        await this.#plugins.resolveController(key, getRouteGroup(key)?.toRouteGroup().plugins ?? [], context)
      }
    }
  }

  /**
   * Mounts programmatic routers, whose routes are then compiled and registered exactly like a controller's.
   *
   * Routing is built once, during start-up, so this has to be called before the application is ready.
   *
   * ```ts
   * app.mount(pets, orders)
   * await app.bootstrap()
   * ```
   *
   * The application comes back carrying the mounted routers' routes in its type, so `RoutesOf<typeof app>` is the
   * whole surface a generated client would call. A router bound to another adapter does not compile.
   */
  mount<const RS extends ReadonlyArray<Router<any, any, any, any, any, T>>>(
    ...routers: RS
  ): WebApplication<T, ROUTES | RoutesOfRouter<RS[number]>, DEPS | DepsOfRouter<RS[number]>, C>
  mount(...routers: Router<any, any, any, any, any, any>[]): this {
    if (this.#built) {
      throw new ErrConfiguration(
        errMessage('Cannot mount a router: routing has already been built')
          .solutions('Call "mount()" before the application is started')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    this.#mounted.push(...routers)

    return this
  }

  /**
   * Where routes come from. One source per way of declaring them; a route declared any of those ways is
   * compiled the same and registered the same.
   *
   * The programmatic source is added only when something was mounted, so an application declaring every route
   * with decorators builds exactly what it built before there was a second way.
   */
  protected routeSources(): RouteSource<T['request']>[] {
    const sources: RouteSource<T['request']>[] = [new ControllerRouteSource<T['request']>()]

    if (this.#mounted.length > 0) {
      sources.push(new FluentRouteSource<T['request']>(this.#mounted, this.#plugins.childrenOf))
    }

    return sources
  }

  protected override async setup(): Promise<void> {
    // One context for everything built from here on. `log` is the configured logger by now. Its `app` is closed:
    // each plugin slot hands its plugins an `app` of its own.
    const context: HTTPSetupContext = {
      container: this.container,
      config: this.configSnapshot,
      store: this.configStore,
      logger: this.log,
      hasFeature: name => this.hasFeature(name),
      app: closedApplicationOps(),
    }

    // Before routing is built: a router's plugins may nest the routers it is built from.
    await this.#plugins.resolveRouters(this.#mounted, context)
    await this.#controllerPlugins(context)

    const routing = buildRouting<T['request']>(this.routeSources(), this.container)
    const servers = new ServerSet<T>([
      this.#own as ServerDefinition<T>,
      ...(this.container.getManyOptional(ServerDefinition) as ServerDefinition<T>[]),
    ])
    this.#servers = servers

    // Every group compiles here, before any server is built, so a route that cannot compile fails before anything
    // has started. Each server serves the routers bound to it; the application's own, the unbound ones.
    this.#routeGroups = servers.select(routing)
    this.#built = true

    await servers.setup(this.#adapter, {
      context,
      plugins: this.#plugins,
      compileRouteGroup: routing.compileRouteGroup,
    })

    this.#listeners = listenerServers(servers.named!)
  }

  protected override async start(): Promise<void> {
    // The application's own server first: under Watt, the first listen to complete is the one it takes over. Only
    // `run()` gets here, and it records its arguments before it does.
    await this.#servers?.run(this.#runArgs!)
  }

  protected override runInfo(): WebRunInfo {
    // Read once `start()` has resolved, and a server that has run has an address until it is torn down.
    return { ...super.runInfo(), address: this.address! }
  }

  /**
   * Readies the application if needed and starts the server with what the adapter's `run` takes — under Fastify,
   * listen options merged over the `listener` that `.server(...)` returned, these winning key by key. Each
   * listener starts after it, on its own settings alone.
   *
   * Runs once: a second call is refused rather than joined, since it would otherwise lose its listen options.
   *
   * @throws ErrApplicationRunning when `run()` has already been called, whatever became of that call.
   * @throws ErrApplicationClosed once {@link close} has been called, including while `run()` was still booting.
   */
  override run(...args: T['runArgs']): Promise<WebRunInfo> {
    // The first call's: a second one is refused, and must not change what the first listens with while it boots.
    this.#runArgs ??= args
    // runInfo() is overridden, so what base run() resolves to is already a WebRunInfo.
    return super.run() as Promise<WebRunInfo>
  }

  // Tolerates a server that was never built: `close()` runs `stop()` whether or not `bootstrap()` got that far.
  protected override async stop(): Promise<void> {
    // The application's own server first, so probes and metrics on a listener answer throughout its drain.
    const failures = (await this.#servers?.teardown()) ?? []

    if (failures.length === 1) {
      throw failures[0]
    }

    if (failures.length > 1) {
      throw new AggregateError(failures, 'Cannot close every server')
    }
  }

  protected override async forceStop(): Promise<void> {
    await this.#servers?.forceTeardown()
  }

  /** @throws ErrApplicationNotReady before {@link setup} has built the server. */
  #ownServer(): IAdapterServer<T> {
    const server = this.#servers?.own

    if (server === undefined) {
      throw new ErrApplicationNotReady('reach the server')
    }

    return server
  }
}

/** The routes one router declares, distributed so a union of routers folds into a union of their routes. */
type RoutesOfRouter<T> = T extends Router<any, any, any, any, infer R, any> ? R : never

/**
 * What one router injected, distributed the same way — `DepsOf` intersects the union back into one bag.
 *
 * A router that injected nothing carries `undefined` rather than `never`, and unioning that in would make every
 * application that mounted one report `undefined` as its dependencies. It contributes nothing instead.
 */
type DepsOfRouter<T> = T extends Router<any, any, infer D, any, any, any> ? (D extends undefined ? never : D) : never
