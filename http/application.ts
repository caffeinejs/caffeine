import type { Container } from '@caffeinejs/di'
import {
  Application,
  kAddConfigurer,
  type ApplicationOptions,
  type ExtensionRegistrar,
  type Feature,
  type FeatureConfigurer,
  type RunInfo,
} from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback, FastifyRequest } from 'fastify'

import type { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'
import { controllerPlugins } from './decorators/use.js'
import { ErrConfiguration, ErrShutdownTimeout } from './error/common.js'
import { ErrorHandlingServiceConfigurer } from './error/error.js'
import { solutions } from './error/util.js'
import { GuardsBuilder } from './guards/builder.js'
import {
  MiddlewarePipeline,
  isMiddlewareOptions,
  type MiddlewareConfigFactory,
  type MiddlewareFn,
  type MiddlewareHook,
  type MiddlewareOptions,
  type MiddlewarePath,
  type MiddlewareResolvable,
  type MiddlewareTarget,
  type Next,
  type NodeMiddleware,
} from './middleware/index.js'
import type { HTTPPluginFactory } from './plugin.js'
import { HTTPPlugins } from './plugin_registry.js'
import type { RouteGroup } from './route.js'
import type { RouteGroupCompiler } from './routing/compile.js'
import { ControllerRouteSource } from './routing/decorated/source.js'
import { buildRouting, type RouteSource } from './routing/index.js'
import type { Router } from './routing/programmatic/router.js'
import { FluentRouteSource, routerStates } from './routing/programmatic/source.js'
import { AuthenticationBuilder } from './security/auth/builder.js'
import { AuthorizationBuilder } from './security/authz/index.js'
import { ServerBuilder, type ServerAddress } from './server/index.js'
import { Keys } from './symbols.js'

export interface AdapterIn<R> {
  routeGroups: RouteGroup<R>[]
  /** The compiler {@link buildRouting} built the groups above with — reused by `$route` for a late one. */
  compileRouteGroup: RouteGroupCompiler
  middlewares: MiddlewarePipeline
  /** What the features contributed, in the order they were installed. */
  plugins: HTTPPlugins
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

export interface Adapter<I, R> {
  get instance(): I

  /** Where the server is listening, or `undefined` before {@link run} and after {@link teardown}. */
  get address(): ServerAddress | undefined

  setup(input: AdapterIn<R>): Promise<void>
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
}

export type AdapterFactory<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>> = (input: AdapterFactoryIn) => A

export type WebApplicationOptions<TConfig = unknown> = ApplicationOptions<TConfig>

/**
 * The HTTP application: an {@link Application} whose lifecycle steps drive a Fastify {@link Adapter}.
 * `setup()` builds routing and sets the adapter up; `start()` runs it;
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
  I = FastifyInstance,
  R = FastifyRequest,
  A extends Adapter<I, R> = Adapter<I, R>,
  ROUTES = never,
  DEPS = never,
  C = unknown,
> extends Application<C> {
  /** Phantom — names the routes mounted on this application, for `RoutesOf`. Never assigned, never read. */
  declare readonly __routes?: ROUTES

  /** Phantom — names what the mounted routers injected, for `DepsOf`. Never assigned, never read. */
  declare readonly __deps?: DEPS

  readonly #adapter: A
  readonly #middlewares = new MiddlewarePipeline()
  readonly #plugins = new HTTPPlugins()
  readonly #pluginFactories: { order: number; factory: HTTPPluginFactory<C> }[] = []
  readonly #featureOrder = new Map<Feature, number>()
  #nextOrder = 0
  #routeGroups: RouteGroup<R>[] = []
  #mounted: Router<any, any, any, any, any>[] = []
  #built = false

  #authBuilder: AuthenticationBuilder | undefined
  #authzBuilder: AuthorizationBuilder | undefined
  #guardsBuilder: GuardsBuilder | undefined
  readonly #serverBuilder = new ServerBuilder<unknown>()

  constructor(adapterFactory: AdapterFactory<I, R, A>, options: WebApplicationOptions<C> = {}) {
    super(options)

    // Registered unconditionally: every application has a listen address. Configuration reaches it only
    // through `.server((s, c) => s.withConfig(...))` — declaring `server` in the schema is not enough.
    this.#installFeature(this.#serverBuilder)

    // Graceful shutdown is `Application`'s own unconditional feature — inherited, not duplicated here.

    this.#adapter = adapterFactory({ container: this.container })
  }

  /**
   * Installs a feature and records the call-order sequence number it registers Fastify plugins under —
   * the same sequence `.with(factory)` draws from, so a feature and a plugin factory interleave in the
   * order they were written regardless of which registry each lives in. See {@link extensionRegistrar}.
   */
  #installFeature(feature: Feature<C>): void {
    this.#featureOrder.set(feature, this.#nextOrder++)
    this.addFeature(feature)
  }

  get instance(): I {
    return this.#adapter.instance
  }

  /**
   * Where the server is listening, or `undefined` until {@link run} has bound a socket. Reports what the
   * socket actually got, so it is the way to reach an application started on port `0`.
   */
  get address(): ServerAddress | undefined {
    return this.#adapter.address
  }

  get routeGroups(): RouteGroup<R>[] {
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
   * container key, or `(config) => middleware` called once at start-up with the application's config handle.
   *
   * `hook` defaults to `onRequest`. A Caffeine middleware may hint a different hook with
   * {@link kMiddlewareHook}; `{ hook }` on this call overrides that hint. See {@link MiddlewareHook}. Answer
   * the request with `ctx.body()` and do not call `next`.
   *
   * ```ts
   * app.use(RequestLogger)
   * app.use('/admin', kRateLimiter, { hook: 'preHandler' })
   * app.use(c => rateLimit(c.limits))
   * ```
   *
   * A middleware naming the variables it writes is taken at its word: the routers it ends up in front of are
   * declared elsewhere, so nothing here checks that they declare the same ones.
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions,
  ): this
  use(target: NodeMiddleware, options?: MiddlewareOptions): this
  use(target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions): this
  use(target: MiddlewareConfigFactory<C>, options?: MiddlewareOptions): this
  use(target: MiddlewareResolvable, options?: MiddlewareOptions): this
  use<V = Record<never, never>, Conf = Record<never, never>>(
    path: MiddlewarePath,
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions,
  ): this
  use(path: MiddlewarePath, target: NodeMiddleware, options?: MiddlewareOptions): this
  use(path: MiddlewarePath, target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions): this
  use(path: MiddlewarePath, target: MiddlewareConfigFactory<C>, options?: MiddlewareOptions): this
  use(path: MiddlewarePath, target: MiddlewareResolvable, options?: MiddlewareOptions): this
  use(
    pathOrTarget: MiddlewarePath | MiddlewareTarget<C> | ((req: never, res: never, next: Next) => void),
    targetOrOptions?: MiddlewareTarget<C> | MiddlewareOptions | ((req: never, res: never, next: Next) => void),
    options?: MiddlewareOptions,
  ): this {
    const parsed = parseUse<C>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Installs a feature, or registers a Fastify plugin from a factory. Both take their position in the same
   * list as `.authentication(...)`, so features and plugins register in the order these calls are written:
   *
   * ```ts
   * createWebApplication()
   *   .with(staticFiles(s => s.serve('public')))
   *   .with(c => corsPlugin(c.app.cors.options))
   *   .with(HTTPCaching(cache => cache.statusHeader('X-Edge')))
   * ```
   *
   * A feature is deduplicated by name — see {@link Application.with}. A plugin factory is never
   * deduplicated — two calls register two plugins. A `fastify-plugin` name already on that instance is
   * refused at register time.
   *
   * @throws ErrFeatureAlreadyInstalled when a feature with the same name is already installed.
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  // HTTPPluginFactory<C> listed before Feature<C>: TypeScript checks overloads in declaration order, and for
  // a generic argument expression like `health((h, c) => h.withConfig(c.app.health))`, only the first
  // structurally-compatible overload gets to contextually type it and drive C's inference. With Feature<C>
  // listed first, a config-consuming HTTPPluginFactory<C>-returning call (health(), and any future one like
  // it) silently inferred C as unknown instead of the application's real config type. Swapping the order
  // fixes it; collapsing to one union-typed signature would too, but this keeps the two call shapes documented
  // separately.
  override with(factory: HTTPPluginFactory<C>): this
  override with(feature: Feature<C>): this
  override with(featureOrFactory: Feature<C> | HTTPPluginFactory<C>): this {
    if (typeof featureOrFactory === 'function') {
      this.assertConfigurable()
      this.#pluginFactories.push({ order: this.#nextOrder++, factory: featureOrFactory })
      return this
    }

    this.#featureOrder.set(featureOrFactory, this.#nextOrder++)
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
      this.#installFeature(this.#authBuilder)
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
      this.#installFeature(this.#authzBuilder)
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
      this.#installFeature(this.#guardsBuilder)
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
      this.#installFeature(this.#authzBuilder)
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
   * `order` is the feature's positional index in {@link configurers}, not its true install-order sequence
   * number — index `0` is always the framework-prepended `ErrorHandlingServiceConfigurer`, which always
   * leads. Every other index is translated back to the sequence number recorded when the feature was
   * installed, so a feature's plugin sorts against `.with(factory)` plugins in the order both were actually
   * written.
   */
  protected override extensionRegistrar(order: number): ExtensionRegistrar<FastifyPluginCallback | FastifyPluginAsync> {
    const trueOrder = order === 0 ? -1 : this.#featureOrder.get(this.configurers()[order]!)!
    return this.#plugins.registrarFor(trueOrder)
  }

  /**
   * The bootstrap order, which is the order the plugins register in.
   *
   * Error handling leads, so every route and hook the rest register is already covered by it. Everything
   * after it — this package's own features and the user's alike — runs in the order `.with(...)` calls were
   * written.
   */
  protected override configurers(): Feature[] {
    return [new ErrorHandlingServiceConfigurer(), ...this.services]
  }

  /**
   * Resolves the root-level plugin factories `.with(factory)` collected, in the order they were written —
   * see {@link extensionRegistrar}. Registers straight into {@link HTTPPlugins}, the same sink a feature's
   * own bootstrap writes to; nothing here goes through the `Feature`/`BootstrapKit` machinery.
   */
  async #registerPlugins(): Promise<void> {
    for (const { order, factory } of this.#pluginFactories) {
      // configHandle is deliberately ConfigHandle<unknown> on the base class (see std's Application); it is
      // this application's own handle for its own C, so this narrows exactly what `kit.config` gave the
      // factory when it ran through `HTTPPluginFeature`'s BootstrapKit<C>.
      this.#plugins.registrarFor(order).register(await factory(this.configHandle as ConfigHandle<C>, this.container))
    }
  }

  /**
   * Resolves the plugins a mounted router or a controller registered, each paired with what registered it.
   *
   * Later than the application's own, which already ran from bootstrap: routing is what needs these, and by
   * the time it is built the configuration has resolved and the container has initialized — so a factory here
   * sees exactly what one passed to the application's `.with(...)` sees.
   */
  async #registerScopedPlugins(): Promise<void> {
    const register = async (scope: object, factories: readonly HTTPPluginFactory[]): Promise<void> => {
      const registrar = this.#plugins.registrarFor(this.#plugins.size, scope)

      for (const factory of factories) {
        registrar.register(await factory(this.configHandle, this.container))
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
   * whole surface a generated client would call.
   */
  mount<const RS extends ReadonlyArray<Router<any, any, any, any, any>>>(
    ...routers: RS
  ): WebApplication<I, R, A, ROUTES | RoutesOfRouter<RS[number]>, DEPS | DepsOfRouter<RS[number]>, C>
  mount(...routers: Router<any, any, any, any, any>[]): this {
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
  protected routeSources(): RouteSource<R>[] {
    const sources: RouteSource<R>[] = [new ControllerRouteSource<R>()]

    if (this.#mounted.length > 0) {
      sources.push(new FluentRouteSource<R>(this.#mounted))
    }

    return sources
  }

  protected override async setup(): Promise<void> {
    const { routeGroups, compileRouteGroup } = buildRouting<R>(this.routeSources(), this.container)
    this.#routeGroups = routeGroups
    this.#built = true

    await this.#registerPlugins()
    await this.#registerScopedPlugins()

    await this.#adapter.setup({
      routeGroups: this.#routeGroups,
      compileRouteGroup,
      middlewares: this.#middlewares,
      plugins: this.#plugins,
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
 * `.with(c => corsPlugin(c.app.cors.options))`.
 *
 * ```ts
 * createWebApplication()
 *   .with(staticFiles(s => s.serve('public')))
 * ```
 */
// Default Fastify — no adapter factory or Fastify instance required.
export function createWebApplication<TConfig = unknown>(
  options?: WebApplicationOptions<TConfig>,
): WebApplication<
  FastifyInstance,
  FastifyRequest,
  FastifyAdapter<FastifyInstance, FastifyRequest>,
  never,
  never,
  TConfig
>
// Explicit adapter factory — a customized Fastify instance (`fastifyAdapterFactory(myFastify)`) or a
// custom adapter altogether.
export function createWebApplication<I, REQ, A extends Adapter<I, REQ> = Adapter<I, REQ>, TConfig = unknown>(
  adapterFactory: AdapterFactory<I, REQ, A>,
  options?: WebApplicationOptions<TConfig>,
): WebApplication<I, REQ, A, never, never, TConfig>
export function createWebApplication(
  first?: AdapterFactory<any, any> | WebApplicationOptions,
  second?: WebApplicationOptions,
): WebApplication<any, any> {
  return typeof first === 'function'
    ? new WebApplication(first, second ?? {})
    : new WebApplication(fastifyAdapterFactory(), first ?? {})
}

function parseUse<C>(
  pathOrTarget: MiddlewarePath | MiddlewareTarget<C> | ((req: never, res: never, next: Next) => void),
  targetOrOptions: MiddlewareTarget<C> | MiddlewareOptions | ((req: never, res: never, next: Next) => void) | undefined,
  options: MiddlewareOptions | undefined,
  argCount: number,
): { path: MiddlewarePath | undefined; target: unknown; hook?: MiddlewareHook } {
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
    hook: isMiddlewareOptions(targetOrOptions) ? targetOrOptions.hook : undefined,
  }
}

/** The routes one router declares, distributed so a union of routers folds into a union of their routes. */
type RoutesOfRouter<T> = T extends Router<any, any, any, any, infer R> ? R : never

/**
 * What one router injected, distributed the same way — `DepsOf` intersects the union back into one bag.
 *
 * A router that injected nothing carries `undefined` rather than `never`, and unioning that in would make every
 * application that mounted one report `undefined` as its dependencies. It contributes nothing instead.
 */
type DepsOfRouter<T> = T extends Router<any, any, infer D, any, any> ? (D extends undefined ? never : D) : never
