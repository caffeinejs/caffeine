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
import type { Logger } from '@caffeinejs/std/logger'

import { AdapterExtensions, type AdapterExtensionFactory } from './adapter_extension.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import type { AdapterTypes } from './adapter_types.js'
import { controllerPlugins } from './decorators/use.js'
import { ErrConfiguration, ErrShutdownTimeout } from './error/common.js'
import { ErrorHandlingServiceConfigurer } from './error/error.js'
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
import type { RouteGroup } from './route.js'
import type { RouteGroupCompiler } from './routing/compile.js'
import { ControllerRouteSource } from './routing/decorated/source.js'
import { buildRouting, type RouteSource } from './routing/index.js'
import type { Router } from './routing/programmatic/router.js'
import { FluentRouteSource, routerStates } from './routing/programmatic/source.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { ServerBuilder, type ServerAddress } from './server/index.js'
import type { HTTPSetupContext } from './setup_context.js'
import { Keys } from './symbols.js'

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
  get instance(): T['instance']

  /** Where the server is listening, or `undefined` before {@link run} and after {@link teardown}. */
  get address(): ServerAddress | undefined

  setup(input: AdapterIn<T>): Promise<void>
  run(): Promise<void>
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

  /**
   * The application's logger, as it stands when the adapter is constructed — the eager one, since no feature has
   * configured yet. An adapter whose server takes its logger at construction has no later chance to read it.
   */
  logger: Logger
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
 *   .server(s => s.port(3000))
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
  #routeGroups: RouteGroup<T['request']>[] = []
  #mounted: Router<any, any, any, any, any, any>[] = []
  #built = false

  // Held rather than built per `configurers()` call: the instance that configured is the one whose server hook
  // installs, and it holds what its configure step bound.
  readonly #errorHandling = new ErrorHandlingServiceConfigurer()

  #authBuilder: AuthenticationBuilder | undefined
  #authzBuilder: AuthorizationBuilder | undefined
  #guardsBuilder: GuardsBuilder | undefined
  readonly #serverBuilder = new ServerBuilder<unknown>()

  constructor(adapterFactory: AdapterFactory<T>, options: WebApplicationOptions<C> = {}) {
    super(options)

    // Registered unconditionally: every application has a listen address. Configuration reaches it only
    // through `.server((s, c) => s.config(...))` — declaring `server` in the schema is not enough.
    this.addFeature(this.#serverBuilder)

    // Graceful shutdown is `Application`'s own unconditional feature — inherited, not duplicated here.

    this.#adapter = adapterFactory({ container: this.container, logger: this.log })
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
   *   .with(({ config }) => corsPlugin(config.app.cors.options))
   *   .with(HTTPCaching(cache => cache.statusHeader('X-Edge')))
   * ```
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
  // `health((h, c) => …)` has its callback typed against the first overload TypeScript tries, and those types
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

    this.#authBuilder[kAddConfigurer](configure as never)

    return this
  }

  /**
   * Configures authorization. Runs immediately: there is nothing to read from the configuration tree, so
   * there is no `(a, c)` callback and nothing is queued for bootstrap — unlike `.server((s, c) => …)`.
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
   * Runs immediately: guards have nothing to read from the configuration tree, so there is no `(g, c)`
   * callback and nothing is queued for bootstrap — unlike `.server((s, c) => …)`.
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

  /** @throws ErrApplicationStarted when {@link ready} has already started. */
  server(configure: FeatureConfigurer<ServerBuilder<C>, C>): this {
    this.assertConfigurable()
    this.#serverBuilder[kAddConfigurer](configure as never)
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
    await this.#registerExtensions(context as HTTPSetupContext<C>)
    await this.#registerScopedExtensions(context)

    await this.#adapter.setup({
      routeGroups: this.#routeGroups,
      compileRouteGroup,
      context,
      middlewares: this.#middlewares,
      extensions: this.#extensions,
    })
  }

  protected override start(): Promise<void> {
    return this.#adapter.run()
  }

  protected override runInfo(): WebRunInfo {
    return { ...super.runInfo(), address: this.address }
  }

  override run(): Promise<WebRunInfo> {
    // runInfo() is overridden, so what base run() resolves to is already a WebRunInfo.
    return super.run() as Promise<WebRunInfo>
  }

  /**
   * Tears the adapter down under the shutdown budget. When it expires, connections are forced shut rather than
   * left for the orchestrator's `SIGKILL` — which would arrive moments later and take the rest of the process
   * with it, logs included.
   */
  protected override async stop(): Promise<void> {
    const timeoutMs = this.shutdownOptions().shutdownTimeoutMs
    const teardown = this.#adapter.teardown()

    if (timeoutMs <= 0) {
      return teardown
    }

    // The race subscribes to the teardown, so a rejection arriving after the timeout is still observed.
    const completed = teardown.then(() => 'done' as const)

    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })

    try {
      if ((await Promise.race([completed, expired])) === 'done') {
        return
      }

      await this.#adapter.forceTeardown?.()
      await teardown.catch(() => undefined)

      throw new ErrShutdownTimeout(timeoutMs)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Creates a web application.
 *
 * Install features with `.with(feature)` or `.with(feature(configure))` rather than here: it can be
 * called at any point in the chain before `ready()`. Configuration is built separately with
 * `newConfiguration` and passed in as `{ config }`. A plugin factory is
 * `.with(({ config }) => corsPlugin(config.app.cors.options))`.
 *
 * ```ts
 * createWebApplication()
 *   .with(staticFiles(s => s.serve('public')))
 * ```
 */
// Default Fastify — no adapter factory or Fastify instance required.
export function createWebApplication<TConfig = unknown>(
  options?: WebApplicationOptions<TConfig>,
): WebApplication<FastifyTypes, never, never, TConfig>
// Explicit adapter factory — a customized Fastify instance (`fastifyAdapterFactory(myFastify)`) or a
// custom adapter altogether.
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
