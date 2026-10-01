import { token } from '@caffeinejs/di'
import {
  FeatureBuilder,
  kFeatureName,
  type Feature,
  type FeatureConfigureKit,
  type FeatureConfigurer,
} from '@caffeinejs/std'

import type { AdapterTypes, ServerAddress, ServerConfigurer } from '../adapter.js'
import type { FastifyTypes } from '../fastify_adapter.js'
import type { FastifyMiddlewareHook } from '../middleware/fastify.js'
import {
  parseUse,
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewareOptions,
  type MiddlewarePath,
  type MiddlewareResolvable,
  type MiddlewareTarget,
  type Next,
  type NodeMiddleware,
} from '../middleware/middleware.js'
import { MiddlewarePipeline } from '../middleware/pipeline.js'
import type { HTTPPluginFactory } from '../plugin.js'
import { assertPluginFactory } from '../plugin_factory.js'
import { foldAuthz } from '../routing/inherit.js'
import type { RouteAuthz, RouteAuthzOptions } from '../routing/spec.js'
import { OpsDefinition } from './definition.js'

/**
 * Fluently builds one ops server: a server of its own, on its own port, serving the routers bound to it with
 * `bindTo(name)` or `@BindTo(name)` and nothing else.
 *
 * The application builds it the way it builds its own server — the same request context, error handling, cookies
 * and start-up checks — and listens on it after its own, closing it after its own. Its plugins and middleware are
 * its own, registered here with `with(...)`, `use(...)` and `useFn(...)`: nothing the application registers on its
 * own server reaches it, an authentication gate included, and neither do the base path and the server callbacks. A
 * router's own plugins and guards, `router.plugin(...)` or `@Use(...)` and `router.guards(...)` or
 * `@UseGuards(...)`, go wherever the router does.
 */
export class OpsBuilder<C = unknown> extends FeatureBuilder<C> {
  get [kFeatureName](): string {
    return `ops:${this.#name}`
  }

  readonly #name: string
  readonly #server: ServerConfigurer<FastifyTypes, C>[] = []
  readonly #plugins: HTTPPluginFactory<C>[] = []
  readonly #middlewares = new MiddlewarePipeline<FastifyMiddlewareHook>()
  #authz: RouteAuthz | undefined

  constructor(name: string, configure?: FeatureConfigurer<OpsBuilder<C>, C>) {
    super(configure as FeatureConfigurer<never, C> | undefined)
    this.#name = name
  }

  /**
   * Configures the server, the way `.server(...)` configures the application's own: `factory` for Fastify's
   * constructor options, `listener` for `listen()`. Resolved once, at start-up, against the same context a plugin
   * factory gets; several calls shallow-merge section by section, in call order.
   *
   * ```ts
   * .install(Ops('admin', (o, { config }) => o.server(() => ({ listener: config.app.admin }))))
   * ```
   */
  server(configure: ServerConfigurer<FastifyTypes, C>): this {
    this.#server.push(configure)
    return this
  }

  /**
   * Registers a server plugin on this server from a factory, the way the application's `.with(...)` registers one on
   * its own: after the framework's head slots (error handling, cookies), in the order these calls are written.
   *
   * ```ts
   * .install(Ops('admin', o => o.with(authentication()).with(healthProbes())))
   * ```
   */
  with(factory: HTTPPluginFactory<C>): this {
    assertPluginFactory(factory)
    this.#plugins.push(factory)
    return this
  }

  /**
   * Adds a middleware to this server's request pipeline. It takes what `app.use(...)` takes, a path or none, the
   * middleware, then `{ hook }`, and runs in the order these calls are written in, within a hook. A path is the
   * server's own: an ops server has no base path.
   *
   * ```ts
   * .install(Ops('admin', o => o.use(AuditLog).use('/jobs', kRateLimiter, { hook: 'preHandler' })))
   * ```
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<FastifyMiddlewareHook>,
  ): this
  use(target: NodeMiddleware, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  use(target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  use(target: MiddlewareResolvable, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  use<V = Record<never, never>, Conf = Record<never, never>>(
    path: MiddlewarePath,
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<FastifyMiddlewareHook>,
  ): this
  use(path: MiddlewarePath, target: NodeMiddleware, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  use(
    path: MiddlewarePath,
    target: (req: never, res: never, next: Next) => void,
    options?: MiddlewareOptions<FastifyMiddlewareHook>,
  ): this
  use(path: MiddlewarePath, target: MiddlewareResolvable, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  use(
    pathOrTarget: MiddlewarePath | MiddlewareTarget<C> | ((req: never, res: never, next: Next) => void),
    targetOrOptions?:
      | MiddlewareTarget<C>
      | MiddlewareOptions<FastifyMiddlewareHook>
      | ((req: never, res: never, next: Next) => void),
    options?: MiddlewareOptions<FastifyMiddlewareHook>,
  ): this {
    const parsed = parseUse<C, FastifyMiddlewareHook>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Adds a factory that builds a middleware for this server's pipeline once at start-up, the way `app.useFn(...)`
   * adds one to the application's own.
   *
   * ```ts
   * .install(Ops('admin', o => o.useFn(({ config }) => rateLimit(config.app.adminLimits))))
   * ```
   */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions<FastifyMiddlewareHook>): this
  useFn(
    pathOrTarget: MiddlewarePath | MiddlewareFactory<C>,
    targetOrOptions?: MiddlewareFactory<C> | MiddlewareOptions<FastifyMiddlewareHook>,
    options?: MiddlewareOptions<FastifyMiddlewareHook>,
  ): this {
    const parsed = parseUse<C, FastifyMiddlewareHook>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Authorizes every route the server serves, as the outermost router those routes are nested in: the declaration
   * `router.authorize(...)` takes, reaching each route the way a parent router's does.
   *
   * Requirements add up: a route declaring a policy of its own needs both. A route declared public stays public.
   * A route naming schemes of its own authenticates with those instead. Naming schemes alone still requires an
   * authenticated principal.
   *
   * Authenticating takes a gate on this server, `with(authentication())`: the application's own does not cover it,
   * and start-up refuses a protected route no gate covers. The schemes it names are the ones `Authentication(...)`
   * registered.
   *
   * ```ts
   * .install(Ops('admin', o => o.with(authentication()).authorize({ schemes: ['basic'], roles: ['operator'] })))
   * ```
   */
  authorize(options: RouteAuthzOptions = {}): this {
    this.#authz = foldAuthz(this.#authz, options)
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const definition = new OpsDefinition(
      this.#name,
      [...this.#server] as ServerConfigurer<FastifyTypes>[],
      this.#authz,
      [...this.#plugins] as HTTPPluginFactory[],
      this.#middlewares,
    )

    kit.container.bind(token<OpsDefinition>(Symbol.for(`@caffeinejs/http:ops:${this.#name}`)), t =>
      t.toValue(definition).extends(OpsDefinition).internal(),
    )
  }
}

/**
 * Installs an ops server named `name`: one more port, serving only the routers bound to it.
 *
 * ```ts
 * createWebApplication()
 *   .install(Ops('admin', o => o.server(() => ({ listener: { port: 9464 } })).with(healthProbes())))
 *   .mount(newRouter('/metrics').with(bindTo('admin')).get('/', () => metrics()))
 * ```
 */
export function Ops<C = unknown>(name: string, configure?: FeatureConfigurer<OpsBuilder<C>, C>): Feature<C> {
  return new OpsBuilder<C>(name, configure)
}

/** One ops server, as `app.ops` hands it out: what it is and where it listens, but not its lifecycle. */
export interface OpsServer<T extends AdapterTypes = FastifyTypes> {
  readonly name: string
  readonly instance: T['instance']
  /** Where it listens, or `undefined` until the application runs. */
  readonly address: ServerAddress | undefined
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>
}
