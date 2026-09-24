import type { Container } from '@caffeinejs/di'
import {
  Application,
  kAddConfigurer,
  kFeatureName,
  type ApplicationOptions,
  type Feature,
  type FeatureConfigurer,
  type RunInfo,
} from '@caffeinejs/std'

import { AdapterExtensions, type AdapterExtensionFactory } from './adapter_extension.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import type { AdapterTypes } from './adapter_types.js'
import { CookieBuilder } from './cookie/cookie.js'
import { controllerPlugins } from './decorators/use.js'
import { ErrorHandlingBuilder } from './error/builder.js'
import { ErrConfiguration } from './error/common.js'
import { solutions } from './error/util.js'
import type { FastifyTypes } from './fastify_types.js'
import { kFeatureServer, type HTTPFeature } from './feature.js'
import { GuardsBuilder } from './guards/builder.js'
import {
  MiddlewarePipeline,
  isMiddlewareOptions,
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewareOptions,
  type MiddlewarePath,
  type MiddlewareResolvable,
  type MiddlewareTarget,
  type Next,
  type NodeMiddleware,
} from './middleware/index.js'
import type { RouteGroupCompiler } from './routing/compile.js'
import { ControllerRouteSource } from './routing/decorated/source.js'
import { buildRouting, type RouteSource } from './routing/index.js'
import type { Router } from './routing/programmatic/router.js'
import { FluentRouteSource, routerStates } from './routing/programmatic/source.js'
import type { RouteGroup } from './routing/route.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import type { HTTPSetupContext } from './setup_context.js'
import { Keys } from './symbols.js'

/**
 * Where the server ended up listening, as reported by the bound socket — which is not what was asked for:
 * port `0` becomes an OS-assigned port, and a wildcard host stays a wildcard.
 */
export interface ServerAddress {
  /** The bound host, verbatim — a wildcard bind reports `0.0.0.0` or `::`. */
  readonly host: string
  /** The bound port. Never `0`. */
  readonly port: number
  /**
   * An origin that can be connected to. A wildcard {@link host} is rendered as the matching loopback address,
   * since `0.0.0.0` is an address to accept on, not one to dial.
   */
  readonly origin: string
}

/**
 * The callback `.server(configure)` takes: resolves the server's settings against the same context a plugin
 * factory gets, so `config` is the resolved tree and the container resolves. Returns the adapter's own shape —
 * under Fastify, `{ factory, listener }`.
 */
export type ServerConfigurer<T extends AdapterTypes, C = unknown> = (
  context: HTTPSetupContext<C>,
) => T['serverOptions'] | Promise<T['serverOptions']>

/**
 * The callback `.server(_, customize)` takes: handed the server right after the adapter constructs it, before
 * anything is decorated or registered on it.
 */
export type ServerCustomizer<T extends AdapterTypes> = (instance: T['instance']) => void | Promise<void>

/** What an application hands its adapter to set the server up with. */
export interface AdapterIn<T extends AdapterTypes> {
  routeGroups: RouteGroup<T['request']>[]
  /** The compiler {@link buildRouting} built the groups above with — reused by `$route` for a late one. */
  compileRouteGroup: RouteGroupCompiler
  /** What the application hands everything it builds at start-up. The middleware factories run against it. */
  context: HTTPSetupContext
  /** What `app.use()` registered, for the adapter to resolve and attach to its hooks. */
  middlewares: MiddlewarePipeline<T['hook']>
  /** What the features and factories contributed, in the order they were installed. */
  extensions: AdapterExtensions<T['instance'], T['extension']>
  /** What every `.server(configure)` resolved to, merged section by section. Empty when none was made. */
  server: T['serverOptions']
  /** Every `.server(_, customize)` callback folded into one that runs them in call order. `undefined` when none. */
  customize: ServerCustomizer<T> | undefined
}

/** {@link RunInfo} widened with where the HTTP server bound. */
export interface WebRunInfo extends RunInfo {
  /**
   * Where the server is listening, from {@link WebApplication.address}. `undefined` only for a bind
   * with no host and port to report: a unix socket, a named pipe, or an adapter that opens no socket. A TCP
   * bind is set by the time {@link WebApplication.run} resolves.
   */
  readonly address: ServerAddress | undefined
}

/**
 * What drives the server behind a {@link WebApplication}. `T` names every type that belongs to that server, and is
 * what the application, its routers and each request's context are typed with.
 */
export interface Adapter<T extends AdapterTypes> {
  /** @throws ErrApplicationNotReady before {@link setup} has built the server. */
  get instance(): T['instance']

  /** Where the server is listening, or `undefined` before {@link run} and after {@link teardown}. */
  get address(): ServerAddress | undefined

  /** Builds the server from `input.server`, hands it to `input.customize`, then wires everything else onto it. */
  setup(input: AdapterIn<T>): Promise<void>
  /** Starts listening. The arguments are what {@link WebApplication.run} was given, untouched. */
  run(...args: T['runArgs']): Promise<void>
  /** @throws ErrApplicationNotReady before {@link setup} has built the server. */
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>

  teardown(): Promise<void>

  /**
   * Abandons whatever is still in flight so a pending {@link teardown} can finish. Called only when the graceful
   * shutdown budget is exhausted, at which point the orchestrator's `SIGKILL` is the alternative. Adapters that
   * cannot force connections shut may leave it undefined.
   */
  forceTeardown?(): Promise<void>
}

export interface AdapterFactoryIn {
  container: Container
}

export type AdapterFactory<T extends AdapterTypes> = (input: AdapterFactoryIn) => Adapter<T>

export type WebApplicationOptions<TConfig = unknown> = ApplicationOptions<TConfig>

/**
 * The HTTP application: an {@link Application} whose lifecycle steps drive an {@link Adapter}, Fastify's unless
 * another is given. `setup()` builds routing and sets the adapter up; `start()` runs it;
 * `stop()` tears it down. `Application` handles the container, services, and lifecycle hooks.
 *
 * Configures fluently, and is itself the running instance — there is no separate builder:
 *
 * ```ts
 * createWebApplication()
 *   .with(staticFiles(s => s.serve('public')))
 *   .authentication(auth => auth.addJWTBearer(b => b.secret(SECRET)))
 *   .server(() => ({ listener: { port: 3000 } }))
 * ```
 */
export class WebApplication<
  T extends AdapterTypes = FastifyTypes,
  ROUTES = never,
  DEPS = never,
  C = unknown,
> extends Application<C> {
  /** Phantom — names the routes mounted on this application, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: ROUTES

  /** Phantom — names what the mounted routers injected, for `DepsOf`. Never assigned, never read. */
  declare readonly __deps?: DEPS

  readonly #adapter: Adapter<T>
  readonly #middlewares = new MiddlewarePipeline<T['hook']>()
  readonly #extensions = new AdapterExtensions<T['instance'], T['extension']>()
  readonly #installs: Install<T, C>[] = []
  readonly #serverConfigurers: ServerConfigurer<T, C>[] = []
  readonly #serverCustomizers: ServerCustomizer<T>[] = []
  #runArgs: T['runArgs'] | undefined
  #routeGroups: RouteGroup<T['request']>[] = []
  #mounted: Router<any, any, any, any, any, any>[] = []
  #built = false

  // Held rather than built per `configurers()` call: the instance that configured is the one whose server hook
  // installs, and it holds what its configure step bound.
  readonly #errorHandling = new ErrorHandlingBuilder<C>()

  #authBuilder: AuthenticationBuilder<C> | undefined
  #authzBuilder: AuthorizationBuilder | undefined
  #guardsBuilder: GuardsBuilder | undefined
  readonly #cookieBuilder = new CookieBuilder<C>()

  constructor(adapterFactory: AdapterFactory<T>, options: WebApplicationOptions<C> = {}) {
    super(options)

    // Registered unconditionally and ahead of everything `.with(...)` installs, so cookies are parsed before
    // any plugin that reads one runs — the authentication gate included, wherever `.authentication(...)` put
    // it. Only the error handler is installed earlier, and it reads no cookies.
    this.addFeature(this.#cookieBuilder)

    // Graceful shutdown is `Application`'s own unconditional feature — inherited, not duplicated here.

    this.#adapter = adapterFactory({ container: this.container })
  }

  /**
   * Installs a feature without the name check `.with(...)` makes, and records its place in the list
   * `.with(factory)` appends to, so a feature's server hook and a factory's extension install in the order they
   * were written.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  override addFeature(feature: Feature): this {
    super.addFeature(feature)
    this.#installs.push({ feature: feature as Feature<C> })
    return this
  }

  /**
   * The server the adapter built.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built it.
   */
  get instance(): T['instance'] {
    return this.#adapter.instance
  }

  /**
   * Where the server is listening, or `undefined` until {@link run} has bound a socket. Reports what the
   * socket actually got, so it is the way to reach an application started on port `0`.
   */
  get address(): ServerAddress | undefined {
    return this.#adapter.address
  }

  get routeGroups(): RouteGroup<T['request']>[] {
    if (!this.started) {
      throw new Error('Application is not ready')
    }

    return this.#routeGroups
  }

  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response> {
    return this.#adapter.fetch(request, options)
  }

  /**
   * Adds a middleware to the request pipeline. Order matters, and it is the order these calls are written
   * in — within a hook.
   *
   * The first argument may be a path (`string` or `string[]`); `'*'` means every request. The middleware may
   * be a Node `(req, res, next)` function, a Caffeine `(ctx, next)` function, an instance, a class, a
   * container key, or `(context) => middleware` called once at start-up with the configuration, the container
   * and the logger.
   *
   * Which hooks exist is the adapter's: under Fastify, a `FastifyMiddlewareHook`, defaulting to `onRequest`. A
   * Caffeine middleware may hint a different hook with {@link kMiddlewareHook}; `{ hook }` on this call
   * overrides that hint. Answer the request with `ctx.body()` and do not call `next`.
   *
   * ```ts
   * app.use(RequestLogger)
   * app.use('/admin', kRateLimiter, { hook: 'preHandler' })
   * app.use(({ config }) => rateLimit(config.limits))
   * ```
   *
   * A middleware naming the variables it writes is taken at its word: the routers it ends up in front of are
   * declared elsewhere, so nothing here checks that they declare the same ones.
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<T['hook']>,
  ): this
  use(target: NodeMiddleware, options?: MiddlewareOptions<T['hook']>): this
  use(target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions<T['hook']>): this
  use(target: MiddlewareFactory<C>, options?: MiddlewareOptions<T['hook']>): this
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
  use(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions<T['hook']>): this
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
    this.#middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Installs a feature, or an extension of the application's adapter from a factory — under Fastify, a plugin.
   * Both take their position in the same list as `.authentication(...)`, so features and plugins install in the
   * order these calls are written:
   *
   * ```ts
   * createWebApplication()
   *   .with(staticFiles(s => s.serve('public')))
   *   .with(({ config }) => [fastifyCors, config.app.cors.options])
   *   .with(HTTPCaching(cache => cache.statusHeader('X-Edge')))
   * ```
   *
   * A factory needing to configure its plugin hands the plugin back together with its options, rather than
   * wrapping it in one that closes over them: an official plugin already wraps itself in `fastify-plugin`, so
   * registering it directly is what puts its hooks on every route, while a wrapper would take an encapsulation
   * context of its own and cover nothing.
   *
   * A feature is deduplicated by name — see {@link Application.with}. A factory is never deduplicated — two
   * calls register two plugins. A `fastify-plugin` name already on that instance is refused at register time.
   * A factory producing another adapter's extension, or an {@link HTTPFeature} written for another server, does
   * not compile.
   *
   * @throws ErrFeatureAlreadyInstalled when a feature with the same name is already installed.
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  // One signature taking the union, not one overload per shape. A generic argument such as
  // `health((h, ctx) => …)` has its callback typed against the first overload TypeScript tries, and those types
  // stick: whichever shape came second — a factory like `health()`, or an `HTTPFeature` factory — silently
  // inferred C as unknown instead of the application's configuration type.
  override with(
    featureOrFactory: AdapterExtensionFactory<T['extension'], C> | HTTPFeature<C, T['instance']> | PlainFeature<C>,
  ): this {
    if (typeof featureOrFactory === 'function') {
      this.assertConfigurable()
      this.#installs.push({ factory: featureOrFactory })
      return this
    }

    // Records its place through `addFeature`, which the base class calls once the name check has passed.
    return super.with(featureOrFactory)
  }

  /**
   * Configures authentication, and puts the gate where this call is written.
   *
   * The `onRequest` hook that authenticates and authorizes registers at this position among the plugins, so a
   * feature or plugin registered before this call runs ahead of it — `cors()`, whose headers a rejected cross-origin
   * request still needs — and one registered after it never runs for a request the gate rejected.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  authentication(configure: FeatureConfigurer<AuthenticationBuilder<C>, C>): this {
    this.assertConfigurable()

    if (this.#authBuilder == null) {
      this.#authBuilder = new AuthenticationBuilder()
      this.addFeature(this.#authBuilder)
    }

    this.#authBuilder[kAddConfigurer](configure)

    return this
  }

  /**
   * Configures authorization. Runs immediately: there is nothing to read from the configuration tree, so
   * there is no `(a, kit)` callback and nothing is queued for bootstrap — unlike `.cookie((k, kit) => …)`.
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  authorization(configure: (authz: AuthorizationBuilder) => void): this {
    this.assertConfigurable()

    if (this.#authzBuilder == null) {
      this.#authzBuilder = new AuthorizationBuilder()
      this.addFeature(this.#authzBuilder)
    }

    configure(this.#authzBuilder)
    return this
  }

  /**
   * Lists the container Keys of guards that run on every route, in registration order, before
   * controller- and method-level `@UseGuards`.
   *
   * Runs immediately: guards have nothing to read from the configuration tree, so there is no `(g, kit)`
   * callback and nothing is queued for bootstrap — unlike `.cookie((k, kit) => …)`.
   *
   * Does not bind the classes. Each Key must already be a container-managed Guard.
   * Calling this is not required for `@UseGuards` on controllers.
   *
   * ```ts
   * createWebApplication()
   *   .guards(g => g.global(RolesGuard, kNamedAuthGuard))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  guards(configure: (guards: GuardsBuilder) => void): this {
    this.assertConfigurable()

    if (this.#guardsBuilder == null) {
      this.#guardsBuilder = new GuardsBuilder()
      this.addFeature(this.#guardsBuilder)
    }

    configure(this.#guardsBuilder)
    return this
  }

  /**
   * Auto-installs authorization when authentication was configured and `.authorization(...)` never was —
   * so a protected route still gets a default policy — before the base class captures the feature list and
   * starts booting. Neither call made means authorization stays off, by design.
   */
  override async ready(): Promise<void> {
    if (this.#authBuilder != null && this.#authzBuilder == null) {
      this.#authzBuilder = new AuthorizationBuilder()
      this.addFeature(this.#authzBuilder)
    }

    return super.ready()
  }

  /**
   * Configures the server the adapter builds at {@link ready}.
   *
   * `configure` resolves against the same context a plugin factory gets and returns the adapter's own settings —
   * under Fastify `{ factory, listener }`, the constructor options and the listen options. `customize` is handed
   * the server right after it is constructed, before the adapter decorates or registers anything on it: a plugin
   * registered there loads ahead of every feature, and a not-found handler set there is kept.
   *
   * Calls accumulate: the settings shallow-merge section by section in call order, and the customizers run in
   * call order. A configuration node handed over as a section is copied, never mutated.
   *
   * ```ts
   * .server(({ config }) => ({ listener: config.app.server }))
   * .server(undefined, instance => instance.addHook('onRoute', seen))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  server(configure?: ServerConfigurer<T, C>, customize?: ServerCustomizer<T>): this {
    this.assertConfigurable()

    if (configure !== undefined) {
      this.#serverConfigurers.push(configure)
    }

    if (customize !== undefined) {
      this.#serverCustomizers.push(customize)
    }

    return this
  }

  /**
   * Configures the cookie parsing every application gets: the signing secret, the serialization defaults, and
   * whether cookies are parsed at all. The feature is registered either way, so this only overrides the
   * defaults — and it is registered ahead of every plugin, so where in the chain the call is written makes no
   * difference.
   *
   * ```ts
   * .cookie((k, { config }) => k.config(config.app.cookie))
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

  /**
   * The configure and bootstrap order.
   *
   * Error handling leads, and its server hook installs first too, so every route and hook the rest register is
   * already covered by it. Everything after it — this package's own features and the user's alike — runs in the
   * order `.with(...)` calls were written.
   */
  protected override configurers(): Feature[] {
    return [this.#errorHandling, ...this.services]
  }

  /**
   * Fills the list the adapter installs on the root server: error handling first, then every feature and factory
   * in the order it was installed. A factory is called here, in that order. A feature's server hook is handed
   * over to run in its slot.
   */
  async #registerExtensions(context: HTTPSetupContext<C>): Promise<void> {
    this.#addServerHook(this.#errorHandling, context)

    for (const install of this.#installs) {
      if ('factory' in install) {
        this.#extensions.add(await install.factory(context))
      } else {
        this.#addServerHook(install.feature, context)
      }
    }
  }

  /** Hands the adapter a feature's server hook, if it has one. Features without one wire no server. */
  #addServerHook(feature: Feature<C>, context: HTTPSetupContext<C>): void {
    // Not checked against `T`: `.with(...)` checked what the application was given, and the built-in features
    // are written against Fastify whatever the adapter.
    if (hasServerHook<C, T['instance']>(feature)) {
      this.#extensions.addFeature(feature[kFeatureName], instance => feature[kFeatureServer](instance, context))
    }
  }

  /**
   * Resolves the extensions a mounted router or a controller registered, each paired with what registered it.
   *
   * After the application's own: routing is what needs these, and by the time it is built the configuration has
   * resolved and the container has initialized — so a factory here sees exactly what one passed to the
   * application's `.with(...)` sees, but for its configuration's type.
   */
  async #registerScopedExtensions(context: HTTPSetupContext): Promise<void> {
    const register = async (scope: object, factories: readonly AdapterExtensionFactory<unknown>[]): Promise<void> => {
      for (const factory of factories) {
        // Unchecked: a router's binding was checked when it was mounted, but a controller's `@Use(...)` never
        // meets the application's type. The adapter refuses what it cannot install.
        this.#extensions.add((await factory(context)) as T['extension'], scope)
      }
    }

    for (const state of routerStates(this.#mounted)) {
      await register(state, state.plugins)
    }

    // Snapshotted by the container when it was constructed, so every controller the application can resolve
    // is already known here — long before routing is built.
    for (const { key } of this.container.getBindingsByLabel(Keys.CONTROLLER)) {
      if (typeof key !== 'function') {
        continue
      }

      await register(key, controllerPlugins(key))
    }
  }

  /**
   * Mounts programmatic routers, whose routes are then compiled and registered exactly like a controller's.
   *
   * Routing is built once, during start-up, so this has to be called before the application is ready.
   *
   * ```ts
   * app.mount(pets, orders)
   * await app.ready()
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
        'Cannot mount a router: routing has already been built' +
          solutions('Call "mount()" before the application is started'),
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
      sources.push(new FluentRouteSource<T['request']>(this.#mounted))
    }

    return sources
  }

  protected override async setup(): Promise<void> {
    const { routeGroups, compileRouteGroup } = buildRouting<T['request']>(this.routeSources(), this.container)
    this.#routeGroups = routeGroups
    this.#built = true

    // One context for everything built from here on. `log` is the configured logger by now.
    const context: HTTPSetupContext = {
      container: this.container,
      config: this.liveConfig,
      store: this.configStore,
      logger: this.log,
    }

    // The live object is deliberately LiveConfig<unknown> on the base class (see std's Application); it is this
    // application's own configuration for its own C, so the application's own factories get it typed.
    //
    // The server's own settings first: they describe what everything below registers onto, and a callback that
    // fails should do so before a factory with side effects has run.
    const server = await this.#resolveServerOptions(context as HTTPSetupContext<C>)
    await this.#registerExtensions(context as HTTPSetupContext<C>)
    await this.#registerScopedExtensions(context)

    await this.#adapter.setup({
      routeGroups: this.#routeGroups,
      compileRouteGroup,
      context,
      middlewares: this.#middlewares,
      extensions: this.#extensions,
      server,
      customize: this.#serverCustomizer(),
    })
  }

  /**
   * Folds every `.server(configure)` result into one, section by section: a section that is an object is
   * shallow-merged over the one before it, anything else replaces. Sections are copied, never aliased — a live
   * configuration node is read-only, and the adapter writes into what it is handed.
   */
  async #resolveServerOptions(context: HTTPSetupContext<C>): Promise<T['serverOptions']> {
    const merged: Record<string, unknown> = {}

    for (const configure of this.#serverConfigurers) {
      for (const [section, value] of Object.entries(await configure(context))) {
        if (value === undefined) {
          continue
        }

        const current = merged[section]
        merged[section] = isPlainObject(value) ? { ...(isPlainObject(current) ? current : {}), ...value } : value
      }
    }

    return merged as T['serverOptions']
  }

  /** Every `.server(_, customize)` callback as one, run in call order; `undefined` when there is none. */
  #serverCustomizer(): ServerCustomizer<T> | undefined {
    if (this.#serverCustomizers.length === 0) {
      return undefined
    }

    const customizers = [...this.#serverCustomizers]

    return async instance => {
      for (const customize of customizers) {
        await customize(instance)
      }
    }
  }

  protected override start(): Promise<void> {
    return this.#adapter.run(...((this.#runArgs ?? []) as T['runArgs']))
  }

  protected override runInfo(): WebRunInfo {
    return { ...super.runInfo(), address: this.address }
  }

  /**
   * Readies the application if needed and starts the server with what the adapter's `run` takes — under Fastify,
   * listen options merged over the `listener` that `.server(...)` returned, these winning key by key.
   */
  override run(...args: T['runArgs']): Promise<WebRunInfo> {
    this.#runArgs = args
    // runInfo() is overridden, so what base run() resolves to is already a WebRunInfo.
    return super.run() as Promise<WebRunInfo>
  }

  protected override stop(): Promise<void> {
    return this.#adapter.teardown()
  }

  protected override async forceStop(): Promise<void> {
    await this.#adapter.forceTeardown?.()
  }
}

/**
 * Creates a web application.
 *
 * Install features with `.with(feature)` or `.with(feature(configure))` rather than here: it can be
 * called at any point in the chain before `ready()`. Configuration is built separately with
 * `newConfiguration` and passed in as `{ config }`. A plugin factory is
 * `.with(({ config }) => [fastifyCors, config.app.cors.options])`.
 *
 * ```ts
 * createWebApplication()
 *   .with(staticFiles(s => s.serve('public')))
 * ```
 */
// Default Fastify — no adapter factory required; `.server(...)` configures the instance it builds.
export function createWebApplication<TConfig = unknown>(
  options?: WebApplicationOptions<TConfig>,
): WebApplication<FastifyTypes, never, never, TConfig>
// Explicit adapter factory — another adapter altogether.
export function createWebApplication<T extends AdapterTypes, TConfig = unknown>(
  adapterFactory: AdapterFactory<T>,
  options?: WebApplicationOptions<TConfig>,
): WebApplication<T, never, never, TConfig>
export function createWebApplication(
  first?: AdapterFactory<any> | WebApplicationOptions,
  second?: WebApplicationOptions,
): WebApplication<any> {
  return typeof first === 'function'
    ? new WebApplication(first, second ?? {})
    : new WebApplication(fastifyAdapterFactory(), first ?? {})
}

function parseUse<C, H extends string>(
  pathOrTarget: MiddlewarePath | MiddlewareTarget<C> | ((req: never, res: never, next: Next) => void),
  targetOrOptions:
    | MiddlewareTarget<C>
    | MiddlewareOptions<H>
    | ((req: never, res: never, next: Next) => void)
    | undefined,
  options: MiddlewareOptions<H> | undefined,
  argCount: number,
): { path: MiddlewarePath | undefined; target: unknown; hook?: H } {
  const asPath =
    Array.isArray(pathOrTarget) ||
    (typeof pathOrTarget === 'string' && argCount >= 2 && !isMiddlewareOptions(targetOrOptions))

  if (asPath) {
    return {
      path: pathOrTarget as MiddlewarePath,
      target: targetOrOptions,
      hook: options?.hook,
    }
  }

  return {
    path: undefined,
    target: pathOrTarget,
    hook: isMiddlewareOptions(targetOrOptions) ? (targetOrOptions.hook as H | undefined) : undefined,
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

/** One entry in the order `.with(...)` was called: a feature, or a factory producing the adapter's extension. */
type Install<T extends AdapterTypes, C> =
  | { readonly feature: Feature<C> }
  | { readonly factory: AdapterExtensionFactory<T['extension'], C> }

/**
 * A feature with no server hook. Spelled out so an {@link HTTPFeature} written for another server cannot pass for a
 * plain feature.
 */
type PlainFeature<C> = Feature<C> & { readonly [kFeatureServer]?: never }

function hasServerHook<C, I>(feature: Feature<C>): feature is HTTPFeature<C, I> {
  return typeof (feature as Partial<HTTPFeature<C, I>>)[kFeatureServer] === 'function'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
