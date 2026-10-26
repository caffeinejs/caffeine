import { ErrApplicationStarted, type FeatureConfigureKit } from '@caffeinejs/application'
import { errMessage } from '@caffeinejs/std/err'

import type {
  AdapterExtensionFactory,
  AnyAdapterExtension,
  AnyAdapterTypes,
  HTTPSetupContext,
  ServerConfigurer,
} from '../../adapter.js'
import type { HTTPPlugin } from '../../plugin.js'
import { assertPluginFactory } from '../../plugin_factory.js'
import { ServerDefinition } from '../../server_definition.js'
import { ErrConfiguration } from '../error/common.js'
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

/**
 * Fluently builds one listener: a server of its own, on its own port, serving the routers bound to it with
 * `bindTo(name)` or `@BindTo(name)` and nothing else. Handed to the callback of `app.listener(name, ...)` or
 * `listenersOf(kit).add(name, ...)`.
 *
 * The application builds it the way it builds its own server — the same request context, error handling, cookies
 * and start-up checks — and starts it after its own, closing it after its own. Its plugins and middleware are
 * its own, registered here with `with(...)`, `use(...)` and `useFn(...)`: nothing the application registers on its
 * own server reaches it, an authentication gate included, and neither do the base path and the server callbacks. A
 * router's own plugins and guards, `router.with(...)` or `@Use(...)` and `router.guards(...)` or
 * `@UseGuards(...)`, go wherever the router does.
 *
 * What a route on it requires is what its router or controller declares, `router.authorize(...)` or
 * `@Authorize(...)`, exactly as on the application's own server. Authenticating takes a gate registered here,
 * `with(authentication())`.
 */
export class ListenerBuilder<C = unknown> {
  readonly #definition: ServerDefinition<AnyAdapterTypes, C>

  constructor(definition: ServerDefinition<AnyAdapterTypes, C>) {
    this.#definition = definition
  }

  /**
   * Configures the server, the way `.server(...)` configures the application's own: `factory` for Fastify's
   * constructor options, `listener` for `listen()`. Resolved once, at start-up, against the same context a plugin
   * factory gets; several calls shallow-merge section by section, in call order.
   *
   * ```ts
   * .listener('admin', (l, { config }) => l.server(() => ({ listener: config.app.admin })))
   * ```
   */
  server(configure: ServerConfigurer<AnyAdapterTypes, C>): this {
    this.#definition.server.push(configure)
    return this
  }

  /**
   * Registers a server plugin on this server from a factory, the way the application's `.with(...)` registers one on
   * its own: after the framework's head slots (error handling, cookies), in the order these calls are written. A
   * factory may return an `HTTPPlugin`, and what either kind of factory mounts or adds with `context.app` lands on
   * this server.
   *
   * ```ts
   * .listener('admin', l => l.with(authentication()).with(healthProbes()))
   * ```
   */
  with(factory: AdapterExtensionFactory<AnyAdapterExtension | HTTPPlugin<AnyAdapterTypes>, C, AnyAdapterTypes>): this {
    assertPluginFactory(factory)
    this.#definition.plugins.push(factory)
    return this
  }

  /**
   * Adds a middleware to this server's request pipeline. It takes what `app.use(...)` takes, a path or none, the
   * middleware, then `{ hook }`, and runs in the order these calls are written in, within a hook. A path is the
   * server's own: a listener has no base path.
   *
   * ```ts
   * .listener('admin', l => l.use(AuditLog).use('/jobs', kRateLimiter, { hook: 'preHandler' }))
   * ```
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<AnyAdapterTypes['hook']>,
  ): this
  use(target: NodeMiddleware, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  use(target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  use(target: MiddlewareResolvable, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  use<V = Record<never, never>, Conf = Record<never, never>>(
    path: MiddlewarePath,
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions<AnyAdapterTypes['hook']>,
  ): this
  use(path: MiddlewarePath, target: NodeMiddleware, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  use(
    path: MiddlewarePath,
    target: (req: never, res: never, next: Next) => void,
    options?: MiddlewareOptions<AnyAdapterTypes['hook']>,
  ): this
  use(path: MiddlewarePath, target: MiddlewareResolvable, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  use(
    pathOrTarget: MiddlewarePath | MiddlewareTarget<C> | ((req: never, res: never, next: Next) => void),
    targetOrOptions?:
      | MiddlewareTarget<C>
      | MiddlewareOptions<AnyAdapterTypes['hook']>
      | ((req: never, res: never, next: Next) => void),
    options?: MiddlewareOptions<AnyAdapterTypes['hook']>,
  ): this {
    const parsed = parseUse<C, AnyAdapterTypes['hook']>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#definition.middlewares.add(parsed.path, parsed.target, parsed.hook)
    return this
  }

  /**
   * Adds a factory that builds a middleware for this server's pipeline once at start-up, the way `app.useFn(...)`
   * adds one to the application's own.
   *
   * ```ts
   * .listener('admin', l => l.useFn(({ config }) => rateLimit(config.app.adminLimits)))
   * ```
   */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions<AnyAdapterTypes['hook']>): this
  useFn(
    pathOrTarget: MiddlewarePath | MiddlewareFactory<C>,
    targetOrOptions?: MiddlewareFactory<C> | MiddlewareOptions<AnyAdapterTypes['hook']>,
    options?: MiddlewareOptions<AnyAdapterTypes['hook']>,
  ): this {
    const parsed = parseUse<C, AnyAdapterTypes['hook']>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#definition.middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }
}

/**
 * Fills a listener's builder. Runs at start-up, once the container has initialized, with the context a plugin
 * factory gets: `config`, `store`, `logger`, a container that resolves, and `hasFeature`.
 */
export type ListenerConfigurer<C = unknown> = (listener: ListenerBuilder<C>, context: HTTPSetupContext<C>) => void

/** What can add a listener: `app.listener(...)` on the application, `listenersOf(kit)` in a feature. */
export interface ListenerAdder<C = unknown> {
  /**
   * Adds a listener named `name`, serving the routers bound to it. The name is taken at once; `configure` runs at
   * start-up.
   *
   * @throws ErrConfiguration when a listener of that name is already added.
   * @throws ErrApplicationStarted once the application has built its servers.
   */
  add(name: string, configure?: ListenerConfigurer<C>): void
}

/** The listeners an application runs besides its own server, in the order they were added. */
export class Listeners<C = unknown> implements ListenerAdder<C> {
  readonly #added: { definition: ServerDefinition<AnyAdapterTypes, C>; configure?: ListenerConfigurer<C> }[] = []
  #built = false

  add(name: string, configure?: ListenerConfigurer<C>): void {
    if (this.#built) {
      throw new ErrApplicationStarted()
    }

    if (this.#added.some(({ definition }) => definition.name === name)) {
      throw new ErrConfiguration(
        errMessage(`Cannot add listener "${name}": a listener named "${name}" is already added`)
          .solutions('Give one of them another name and bind its routers to it with bindTo(...)')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    this.#added.push({ definition: new ServerDefinition<AnyAdapterTypes, C>(name), configure })
  }

  /** Runs every listener's callback, in add order, and hands back what each server is built from. */
  build(context: HTTPSetupContext<C>): ServerDefinition<AnyAdapterTypes, C>[] {
    this.#built = true

    return this.#added.map(({ definition, configure }) => {
      configure?.(new ListenerBuilder(definition), context)
      return definition
    })
  }
}

/** The configure kit a web application hands its features: the usual one, and a way to add a listener. */
export interface HTTPFeatureConfigureKit<C = unknown> extends FeatureConfigureKit<C> {
  readonly listeners: ListenerAdder<C>
}

/**
 * Lets a feature add a listener from its configure step, when the application installing it is a web application.
 *
 * ```ts
 * protected configure(kit: FeatureConfigureKit<C>): void {
 *   listenersOf(kit).add('metrics', l => l.server(() => ({ listener: { port: this.#port } })).with(metrics()))
 * }
 * ```
 *
 * @throws ErrConfiguration when the application is not a web application.
 */
export function listenersOf<C>(kit: FeatureConfigureKit<C>): ListenerAdder<C> {
  const listeners = (kit as Partial<HTTPFeatureConfigureKit<C>>).listeners

  if (listeners === undefined) {
    throw new ErrConfiguration(
      errMessage('Cannot add a listener: the application is not a web application')
        .solutions('Install the feature on createWebApplication()')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return listeners
}
