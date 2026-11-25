import {
  Application,
  ErrApplicationNotReady,
  kAddConfigurer,
  type ApplicationOptions,
  type FeatureConfigurer,
  type RunInfo,
} from '@caffeinejs/application'
import type { ContextKey } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { CookieBuilder } from './core/cookie/cookie.js'
import { ErrConfiguration } from './core/error/common.js'
import { ErrorHandlingBuilder } from './core/error/error.js'
import { HookRegistration } from './core/lifecycle/batch.js'
import { assertHookName, HOOK_NAMES, type HookFn, type HookName } from './core/lifecycle/lifecycle.js'
import { Listeners, type HTTPFeatureConfigureKit, type ListenerConfigurer } from './core/listener/listener.js'
import { listenerServers } from './core/listener/servers.js'
import {
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewareOptions,
  type MiddlewarePath,
  type MiddlewareResolvable,
  type MiddlewareTarget,
} from './core/middleware/index.js'
import { parseUse } from './core/middleware/middleware.js'
import { ControllerRouteSource } from './core/routing/decorated.js'
import { buildRouting, RouteInventory, type RouteSource } from './core/routing/index.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import { FluentRouteSource } from './core/routing/programmatic/source.js'
import type { RoutesOf } from './core/routing/programmatic/types.js'
import type { IRouteGroup } from './core/routing/route.js'
import { AuthorizationBuilder } from './core/security/authz/index.js'
import type { Context } from './core/server/context.js'
import { configurationError, USE_ADAPTER } from './core/server/error.js'
import {
  bindContext,
  fetchAdapter,
  isServerAdapter,
  kHosting,
  type AnyServerAdapter,
  type FetchAdapter,
  type HostedServer,
  type AdapterInstance,
  type AdapterListen,
  type AdapterSettings,
} from './core/server/hosting.js'
import type { HTTPPluginFactory, HTTPSetupContext } from './plugin.js'
import { assertPluginFactory } from './plugin_factory.js'
import type { IServer, ServerAddress, ServerConfigurer, ServerCustomizer } from './server.js'
import { ServerDefinition, type BasePathConfigurer } from './server_definition.js'
import { ServerSet } from './servers.js'

/** {@link RunInfo} widened with where the HTTP server bound. */
export interface WebRunInfo extends RunInfo {
  /** Where the server is listening, from {@link WebApplication.address}. */
  readonly address: ServerAddress
}

/**
 * What `run()` resolves to: with the address under an adapter that listens, without it under none, and with it
 * optional when the adapter is not known, as on a bare `WebApplication`.
 */
export type RunInfoOf<A extends AnyServerAdapter> = [AdapterListen<A>] extends [never]
  ? RunInfo
  : unknown extends AdapterListen<A>
    ? RunInfo & { readonly address?: ServerAddress }
    : WebRunInfo

export interface WebApplicationOptions<
  TConfig = unknown,
  A extends AnyServerAdapter = FetchAdapter,
> extends ApplicationOptions<TConfig> {
  /**
   * What serves the application: `node()` from `@caffeinejs/http-node`, `bun()` from `@caffeinejs/http/bun`. Unset:
   * none, and the runtime is handed {@link WebApplication.fetch}.
   */
  adapter?: A
}

/**
 * The HTTP application: an {@link Application} whose lifecycle steps build, start and tear down its servers, on the
 * runtime its adapter serves: `createWebApplication({ adapter: node() })`. Under no adapter it answers through
 * {@link fetch}. `setup()` builds routing and the servers; `start()` starts them; `stop()` tears them down.
 * `Application` handles the container, features, and lifecycle hooks.
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
 * ```
 */
export class WebApplication<ROUTES = never, DEPS = never, C = unknown, A extends AnyServerAdapter = AnyServerAdapter>
  extends Application<C>
  implements IServer<AdapterInstance<A>>
{
  /** Phantom — names the routes mounted on this application, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: ROUTES

  /** Phantom — names what the mounted routers injected, for `DepsOf`. Never assigned, never read. */
  declare readonly __deps?: DEPS

  /** What serves every server of the application. */
  readonly #adapter: AnyServerAdapter
  /** What `.serverCallback(...)` registered, in call order. */
  readonly #customizers: ServerCustomizer<C, never>[] = []
  /** What the first `run(options)` was given, read as the application's own server starts. */
  #run: { readonly options: object | undefined } | undefined
  /** The slot every engine sets in each request's frame, read by the request-scoped `Context` binding. */
  readonly #contextKey: ContextKey<Context>
  /** What the application's own server is built from: what its fluent methods registered. */
  readonly #own = new ServerDefinition<C>()
  /** Every server, the application's own first, once {@link setup} has read them. */
  #servers: ServerSet | undefined
  /** What {@link listener} and the features added, in that order of calls. */
  readonly #listeners = new Listeners<C>()
  /** The listeners, once {@link setup} has built them. */
  #listenerServers: ReadonlyMap<string, IServer> | undefined
  #routeGroups: IRouteGroup<Context>[] = []
  #built = false
  /** Every server's routes, filled as each is built. */
  readonly #inventory = new RouteInventory()

  // Held as fields: `.errorHandling(...)` and `.cookie(...)` hand their callbacks to the instances installed below.
  readonly #errorHandling = new ErrorHandlingBuilder<C>()
  readonly #cookieBuilder = new CookieBuilder<C>()

  /** @throws ErrConfiguration when `adapter` is not a server adapter. */
  constructor(options: WebApplicationOptions<C, A> = {}) {
    super(options)

    if (options.adapter !== undefined && !isServerAdapter(options.adapter)) {
      throw configurationError(
        'Cannot create the application: "adapter" is not a server adapter',
        USE_ADAPTER,
        'Install @caffeinejs/http and @caffeinejs/http-node at the same exact version, so both load one copy of @caffeinejs/http',
        'Leave adapter out to answer through app.fetch',
      )
    }

    this.#adapter = options.adapter ?? fetchAdapter

    // Installed unconditionally, so their names are dedupe-protected and `hasFeature` answers for them. The
    // order here is configure order only: each binds what its server half runs on, and the engine installs those
    // halves ahead of everything `.with(...)` registers, error handling first, then cookies. Cookies are read lazily,
    // so no plugin that reads one has an order to get right, and the cookie writer's `onSend` hook leads every
    // later plugin's.
    this.install(this.#errorHandling)
    this.install(this.#cookieBuilder)

    // Graceful shutdown is `Application`'s own unconditional feature — inherited, not duplicated here.

    this.#contextKey = bindContext(this.container)
    this.container.bind(RouteInventory, t => t.toValue(this.#inventory).internal())
  }

  /**
   * Where the server is listening, or `undefined` until {@link run} has bound a socket. Reports what the
   * socket actually got, so it is the way to reach an application started on port `0`.
   */
  get address(): ServerAddress | undefined {
    return this.#servers?.own?.address
  }

  /**
   * What serves the application's own server on its runtime: Node's server under `node()`, Bun's under `bun()` once
   * `run()` has started it, `undefined` under no adapter.
   *
   * @throws ErrApplicationNotReady before {@link bootstrap} has built the server.
   */
  get instance(): AdapterInstance<A> {
    // The server came from this application's own adapter, whose instance is `AdapterInstance<A>`.
    return this.#ownServer().instance as AdapterInstance<A>
  }

  /**
   * The listeners {@link listener} and the features added, by name and in the order they were added: empty when none
   * was. Each one's `address` is where to point a client at its routes, and its `instance` what serves them.
   *
   * @throws ErrApplicationNotReady before {@link bootstrap} has built them.
   */
  get listeners(): ReadonlyMap<string, IServer<AdapterInstance<A>>> {
    if (this.#listenerServers === undefined) {
      throw new ErrApplicationNotReady('reach the listeners')
    }

    // Every listener came from this application's own adapter.
    return this.#listenerServers as ReadonlyMap<string, IServer<AdapterInstance<A>>>
  }

  /**
   * Every route group the application declared, compiled, whichever server serves it: the mounted routers' and the
   * controllers'. What a plugin adds, with `context.server.mount(...)` or `$route`, is not among them.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built them.
   */
  get routeGroups(): IRouteGroup<Context>[] {
    if (!this.started) {
      throw new ErrApplicationNotReady('read the route groups')
    }

    return this.#routeGroups
  }

  /**
   * Sends `request` to the application's own server, as {@link IServer.request} describes. Bound to the application,
   * so it can be handed on alone.
   *
   * While {@link close} drains, it is answered 503; once the server is torn down, it rejects.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built the server.
   * @throws ErrApplicationClosed once {@link close} has torn the server down.
   */
  readonly request = async (request: Request | string | URL, options?: RequestInit): Promise<Response> =>
    this.#ownServer().request(request, options)

  /**
   * Answers `request` as the application's own server does, as {@link IServer.fetch} describes: what a fetch runtime
   * is handed, `export default { fetch: app.fetch }`. Bound to the application, so it can be handed on alone.
   *
   * Under an adapter that listens, `fetch` is {@link request}, and rejects as it does once the server is torn down.
   * Under no adapter it keeps answering 503.
   *
   * @throws ErrApplicationNotReady before {@link bootstrap} has built the server.
   * @throws ErrApplicationClosed under an adapter that listens, once {@link close} has torn the server down.
   */
  readonly fetch = (request: Request, ...runtime: unknown[]): Response | Promise<Response> =>
    this.#ownServer().fetch(request, ...runtime)

  /**
   * Adds a middleware to the request pipeline. Order matters, and it is the order these calls are written
   * in — within a hook.
   *
   * The first argument may be a path (`string` or `string[]`); `'*'` means every request. The path only decides
   * whether the middleware runs: `ctx.req.url` reads the same as anywhere else in the request. The middleware may
   * be a `(ctx, next)` function, an instance, a class, or a container key.
   *
   * `{ hook }` is a request hook point (`onRequest`, `preHandler`, `onSend`, `onResponse`, `onError`); `onRequest` by
   * default. A middleware may hint a different hook with {@link kMiddlewareHook}; `{ hook }` on this call overrides
   * that hint. Answer the request with `ctx.body()` and do not call `next`.
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
   * `.listener(name, l => l.use(...))`.
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions,
  ): this
  use(target: MiddlewareResolvable, options?: MiddlewareOptions): this
  use<V = Record<never, never>, Conf = Record<never, never>>(
    path: MiddlewarePath,
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions,
  ): this
  use(path: MiddlewarePath, target: MiddlewareResolvable, options?: MiddlewareOptions): this
  use(
    pathOrTarget: MiddlewarePath | MiddlewareTarget<C>,
    targetOrOptions?: MiddlewareTarget<C> | MiddlewareOptions,
    options?: MiddlewareOptions,
  ): this {
    const parsed = parseUse<C>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#own.middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Adds a factory that builds middleware once at start-up from the configuration, container and logger.
   *
   * This is separate from {@link use} because both a factory and a middleware are functions. The distinct
   * method keeps the factory's setup context inferred without weakening inference for `use`'s middleware signatures.
   *
   * ```ts
   * app.useFn('*', ({ config }) => rateLimit(config.limits))
   * ```
   *
   * Like {@link use}, it reaches the application's own server and no listener.
   */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions): this
  useFn(
    pathOrTarget: MiddlewarePath | MiddlewareFactory<C>,
    targetOrOptions?: MiddlewareFactory<C> | MiddlewareOptions,
    options?: MiddlewareOptions,
  ): this {
    const parsed = parseUse<C>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#own.middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Registers a server plugin from a factory that returns an `HTTPPlugin`. Plugins install on the application's own
   * server, in the order these calls are written, after the framework's own head slots (error handling, cookies):
   *
   * ```ts
   * createWebApplication()
   *   .with(staticFiles(s => s.serve('public')))
   *   .with(corsPolicy(c => c.origins('https://app.example')))
   *   .with(HTTPCaching(cache => cache.statusHeader('X-Edge')))
   * ```
   *
   * A listener installs none of them. It has its own: `.listener(name, l => l.with(...))`.
   *
   * A factory is never deduplicated — two calls register two plugins, a plugin `name` already on that server
   * included. A factory that returns anything but an `HTTPPlugin` is refused at start-up.
   *
   * The plugin's `register` runs on this server. A factory may mount routers on it and add middleware to its pipeline
   * with `context.server`.
   *
   * A feature is not a plugin: install it with {@link Application.install}, at any position in the chain — a
   * feature binds into the container before any factory here runs, so only `.with(...)` order matters.
   *
   * @throws ErrApplicationStarted when {@link bootstrap} has already started.
   */
  with(factory: HTTPPluginFactory<C>): this {
    this.assertConfigurable()
    assertPluginFactory(factory)

    this.#own.plugins.push(factory)
    return this
  }

  /**
   * Adds a hook to the application's own server, in its place among the `.with(...)` plugins: a request hook covers
   * every route the server serves, a server hook runs once. A listener takes its own, `.listener(name, l =>
   * l.hook(...))`. Unlike {@link use}'s middleware, a hook has no path and no `next`: it runs at its point, answers
   * with `ctx.body(...)`, and fails by throwing.
   *
   * ```ts
   * createWebApplication()
   *   .hook('onRequest', ctx => { ctx.state.set('started', performance.now()) })
   *   .hook('onResponse', ctx => metrics.observe(ctx))
   *   .hook('onReady', ({ logger }) => logger.info('ready'))
   * ```
   *
   * @throws ErrApplicationStarted when {@link bootstrap} has already started.
   * @throws ErrConfiguration for a point that is not a hook.
   */
  hook<K extends HookName>(name: K, fn: HookFn<K, C>): this {
    this.assertConfigurable()
    assertHookName(name, HOOK_NAMES, 'with app.hook')

    this.#own.plugins.push(() => new HookRegistration(name, fn as HookFn<HookName>))
    return this
  }

  /**
   * Adds a listener: a server of its own, on its own port, serving the routers mounted on it with `l.mount(...)` and
   * the controllers bound to it with `@BindTo(name)`, and nothing else. It starts after the application's own server
   * and closes after it.
   *
   * The name is taken at once. `configure` runs at start-up, once the container has initialized, with the builder
   * and the context a plugin factory gets, so it reads the configuration:
   *
   * ```ts
   * createWebApplication({ config })
   *   .listener('admin', (l, { config }) =>
   *     l
   *       .server(() => ({ bodyLimit: config.app.adminBodyLimit }))
   *       .with(healthProbes())
   *       .mount(new Router('/jobs').get('/', () => listJobs())),
   *   )
   * ```
   *
   * Under no adapter there is no socket: the runtime serves each listener's `app.listeners.get(name).fetch` itself. A
   * feature adds one from its configure step with `listenersOf(kit).add(name, configure)`.
   *
   * @throws ErrConfiguration when a listener of that name is already added.
   * @throws ErrApplicationStarted when {@link bootstrap} has already started.
   */
  listener(name: string, configure?: ListenerConfigurer<C, AdapterSettings<A>>): this {
    this.assertConfigurable()
    this.#listeners.add(name, configure as ListenerConfigurer<C, object> | undefined)
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

  /** The base kit, and the listener list a feature adds to through `listenersOf(kit)`. */
  protected override configureKit(): HTTPFeatureConfigureKit {
    return { ...super.configureKit(), listeners: this.#listeners as Listeners }
  }

  /**
   * Configures the server the application builds at {@link ready}: its own. A listener takes its settings from
   * `.listener(name, l => l.server(...))`.
   *
   * `configure` resolves against the same context a plugin factory gets and returns the application's settings, and
   * what its adapter takes besides: under `node()`, `listen` and Node's `http`, `https` or `http2` options.
   *
   * Calls accumulate: the settings shallow-merge section by section in call order. A configuration node handed
   * over as a section is copied, never mutated.
   *
   * ```ts
   * .server(({ config }) => ({ bodyLimit: config.app.bodyLimit, handlerTimeout: 30 * Second }))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  server(configure: ServerConfigurer<AdapterSettings<A>, C>): this {
    this.assertConfigurable()
    this.#own.server.push(configure as ServerConfigurer<object, C>)
    return this
  }

  /**
   * Hands `callback` the setup context, so the application's configuration, and then the server its adapter built, to
   * configure it: under `node()` right after it is constructed and before it listens; under `bun()` right after
   * `Bun.serve` started it, since Bun builds and listens in one call. The application's own server alone, never a
   * listener's. Calls accumulate and run in call order; a failure fails start-up and closes the server.
   *
   * ```ts
   * .serverCallback(({ config }, server) => {
   *   server.setTimeout(config.app.socketTimeout)
   * })
   * ```
   *
   * @throws ErrApplicationStarted when {@link bootstrap} has already started.
   * @throws ErrConfiguration under no adapter, which builds no server.
   */
  serverCallback(
    callback: [AdapterInstance<A>] extends [undefined] ? never : ServerCustomizer<C, NonNullable<AdapterInstance<A>>>,
  ): this {
    this.assertConfigurable()

    if (this.#adapter === fetchAdapter) {
      throw configurationError(
        'Cannot call serverCallback: the application has no adapter, so no server to hand over',
        USE_ADAPTER,
        'Remove the serverCallback call',
      )
    }

    this.#customizers.push(callback as ServerCustomizer<C, never>)
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
   * calls it still renders a thrown `ErrHTTP` as an RFC 9457 problem, in the format the request's `Accept` asks for.
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
   * whole surface a generated client calls on the application's own server.
   */
  mount<const RS extends ReadonlyArray<AnyRouter>>(
    ...routers: RS
  ): WebApplication<ROUTES | RoutesOf<RS[number]>, DEPS | NonNullable<RS[number]['__deps']>, C, A>
  mount(...routers: AnyRouter[]): this {
    if (this.#built) {
      throw new ErrConfiguration(
        errMessage('Cannot mount a router: routing has already been built')
          .solutions(
            'Call "mount()" before the application is started',
            'From a plugin, mount it on the server the plugin registers on: "context.server.mount(...)"',
          )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    this.#own.routers.push(...routers)

    return this
  }

  /**
   * Readies the application if needed and starts its servers. Under an adapter that listens, `options` merges over the
   * `listen` that `.server(...)` returned, these winning key by key, and resolves with where it listens; each listener
   * starts after it, on its own settings alone. Under an adapter that does not listen, it takes no options.
   *
   * Runs once: a second call is refused rather than joined, since it would otherwise lose its listen options.
   *
   * @throws ErrApplicationRunning when `run()` has already been called, whatever became of that call.
   * @throws ErrApplicationClosed once {@link close} has been called, including while `run()` was still booting.
   */
  override run(options?: AdapterListen<A>): Promise<RunInfoOf<A>> {
    // The first call's: a second one is refused, and must not change what the first listens with while it boots.
    this.#run ??= { options: options as object | undefined }
    // runInfo() is overridden, so what base run() resolves to carries the address of a server that listens.
    return super.run() as Promise<RunInfoOf<A>>
  }

  protected override async setup(): Promise<void> {
    // One context for everything built from here on. `log` is the configured logger by now. It has no `server`: each
    // server hands its plugins one of its own, scoped to where they are registered.
    const context: Omit<HTTPSetupContext, 'server'> = {
      container: this.container,
      config: this.configSnapshot,
      store: this.configStore,
      logger: this.log,
      hasFeature: name => this.hasFeature(name),
    }

    // The application's own server first, then each listener.
    const definitions = [this.#own, ...this.#listeners.build(context as Omit<HTTPSetupContext<C>, 'server'>)]

    const routing = buildRouting<Context>(routeSources(definitions), context)
    const servers = new ServerSet(definitions as unknown as ServerDefinition[])
    this.#servers = servers

    // Every declared group compiles here, before any server is built, so a route that cannot compile fails before
    // anything has started; what a plugin mounts compiles as its server is built. Each server serves the routers
    // mounted on it and the controllers bound to it; the application's own, the unbound controllers too.
    this.#routeGroups = servers.select(routing)
    this.#built = true

    await servers.setup({
      context,
      compileRouteGroup: routing.compileRouteGroup,
      inventory: this.#inventory,
      contextKey: this.#contextKey,
      hosting: settings => this.#adapter[kHosting](settings),
      customize: async (serverContext, instance) => {
        for (const customize of this.#customizers) {
          await customize(serverContext as HTTPSetupContext<C>, instance as never)
        }
      },
    })

    this.#listenerServers = listenerServers(servers.named!)
  }

  protected override async start(): Promise<void> {
    // The application's own server first: under Watt, the first listen to complete is the one it takes over.
    await this.#servers?.run(this.#run?.options)
  }

  protected override runInfo(): RunInfo & { address?: ServerAddress } {
    // Read once `start()` has resolved: a server that listens has an address until it is torn down, one that does not
    // has none.
    const address = this.address

    return address === undefined ? super.runInfo() : { ...super.runInfo(), address }
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
  #ownServer(): HostedServer {
    const server = this.#servers?.own

    if (server === undefined) {
      throw new ErrApplicationNotReady('reach the server')
    }

    return server
  }
}

/**
 * Creates the HTTP application, served by the web-standards engine on the runtime its adapter serves, and listening
 * once `run()` is called:
 *
 * ```ts
 * import { node } from '@caffeinejs/http-node'
 *
 * const app = createWebApplication({ config, adapter: node() }).mount(pets)
 * const { address } = await app.run({ port: 3000 })
 * ```
 *
 * Under no adapter it has no socket of its own: hand `app.fetch` to the runtime once it is ready, as
 * `export default { fetch: app.fetch }`. A setting only a listening adapter takes is refused at start-up.
 *
 * The adapter's type is inferred from `adapter`. Naming `TConfig` alone turns that inference off, as naming any type
 * argument does: the application then takes any adapter's settings and types `app.instance` as `unknown`. Name the
 * adapter too for its own types, `createWebApplication<AppConfig, NodeAdapter>({ config, adapter: node() })`.
 */
export function createWebApplication<TConfig = unknown>(
  options?: ApplicationOptions<TConfig> & { readonly adapter?: undefined },
): WebApplication<never, never, TConfig, FetchAdapter>
export function createWebApplication<TConfig = unknown, A extends AnyServerAdapter = AnyServerAdapter>(
  options: ApplicationOptions<TConfig> & { readonly adapter: A },
): WebApplication<never, never, TConfig, A>
export function createWebApplication<TConfig, A extends AnyServerAdapter>(
  options?: WebApplicationOptions<TConfig, A>,
): WebApplication<never, never, TConfig, A> {
  return new WebApplication(options)
}

/**
 * Where routes come from: the controllers, and what each server in `definitions` has mounted. A route declared any
 * way is compiled the same and registered the same.
 */
function routeSources<C>(definitions: readonly ServerDefinition<C>[]): RouteSource<Context>[] {
  return [
    new ControllerRouteSource<Context>(),
    ...definitions.map(
      definition =>
        new FluentRouteSource<Context>(definition.routers, { server: definition.name, levels: definition.levels }),
    ),
  ]
}
