import { ErrApplicationStarted, type FeatureConfigureKit } from '@caffeinejs/application'
import { errMessage } from '@caffeinejs/std/err'

import type { HTTPPluginFactory, HTTPSetupContext } from '../../plugin.js'
import { assertPluginFactory } from '../../plugin_factory.js'
import type { ServerConfigurer } from '../../server.js'
import { ServerDefinition } from '../../server_definition.js'
import { ErrConfiguration } from '../error/common.js'
import { HookRegistration } from '../lifecycle/batch.js'
import { assertHookName, HOOK_NAMES, type HookFn, type HookName } from '../lifecycle/lifecycle.js'
import {
  parseUse,
  type MiddlewareFactory,
  type MiddlewareFn,
  type MiddlewareOptions,
  type MiddlewarePath,
  type MiddlewareResolvable,
  type MiddlewareTarget,
} from '../middleware/middleware.js'
import type { ServerSettings } from '../server/settings.js'

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
export class ListenerBuilder<C = unknown, S extends object = ServerSettings> {
  readonly #definition: ServerDefinition<C>

  constructor(definition: ServerDefinition<C>) {
    this.#definition = definition
  }

  /**
   * Configures the server, the way `.server(...)` configures the application's own. The settings are what the
   * application's adapter takes: `ServerSettings` under none, `NodeServerSettings` under `node()`, with `listen` for
   * where it listens and `http`, `https` or `http2` for Node's own options. Resolved once, at start-up, against the
   * same context a plugin factory gets; several calls shallow-merge section by section, in call order. Under `node()`:
   *
   * ```ts
   * .listener('admin', (l, { config }) => l.server(() => ({ listen: config.app.admin })))
   * ```
   */
  server(configure: ServerConfigurer<S, C>): this {
    this.#definition.server.push(configure)
    return this
  }

  /**
   * Registers a server plugin on this server from a factory, the way the application's `.with(...)` registers one on
   * its own: after the framework's head slots (error handling, cookies), in the order these calls are written. What
   * its plugin mounts or adds with `context.app` lands on this server.
   *
   * ```ts
   * .listener('admin', l => l.with(authentication()).with(healthProbes()))
   * ```
   */
  with(factory: HTTPPluginFactory<C>): this {
    assertPluginFactory(factory)
    this.#definition.plugins.push(factory)
    return this
  }

  /**
   * Adds a hook to this server, in its place among its `.with(...)` plugins, as the application's `.hook(...)` adds one
   * to its own: nothing the application adds there reaches this server.
   *
   * @throws ErrConfiguration for a point that is not a hook.
   */
  hook<K extends HookName>(name: K, fn: HookFn<K, C>): this {
    assertHookName(name, HOOK_NAMES, 'with listener.hook')
    this.#definition.plugins.push(() => new HookRegistration(name, fn as HookFn<HookName>))
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
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions): this
  useFn(
    pathOrTarget: MiddlewarePath | MiddlewareFactory<C>,
    targetOrOptions?: MiddlewareFactory<C> | MiddlewareOptions,
    options?: MiddlewareOptions,
  ): this {
    const parsed = parseUse<C>(pathOrTarget, targetOrOptions, options, arguments.length)
    this.#definition.middlewares.addFactory(parsed.path, parsed.target, parsed.hook)
    return this
  }
}

/**
 * Fills a listener's builder. Runs at start-up, once the container has initialized, with the context a plugin
 * factory gets: `config`, `store`, `logger`, a container that resolves, and `hasFeature`.
 */
export type ListenerConfigurer<C = unknown, S extends object = ServerSettings> = (
  listener: ListenerBuilder<C, S>,
  context: HTTPSetupContext<C>,
) => void

/**
 * What can add a listener: `app.listener(...)` on the application, `listenersOf(kit)` in a feature. `S` is the
 * settings type the listener's `.server(...)` writes.
 */
export interface ListenerAdder<C = unknown, S extends object = ServerSettings> {
  /**
   * Adds a listener named `name`, serving the routers bound to it. The name is taken at once; `configure` runs at
   * start-up.
   *
   * @throws ErrConfiguration when a listener of that name is already added.
   * @throws ErrApplicationStarted once the application has built its servers.
   */
  add(name: string, configure?: ListenerConfigurer<C, S>): void
}

/** The listeners an application runs besides its own server, in the order they were added. */
export class Listeners<C = unknown> implements ListenerAdder<C, object> {
  readonly #added: { definition: ServerDefinition<C>; configure?: ListenerConfigurer<C, object> }[] = []
  #built = false

  add(name: string, configure?: ListenerConfigurer<C, object>): void {
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

    this.#added.push({ definition: new ServerDefinition<C>(name), configure })
  }

  /** Runs every listener's callback, in add order, and hands back what each server is built from. */
  build(context: HTTPSetupContext<C>): ServerDefinition<C>[] {
    this.#built = true

    return this.#added.map(({ definition, configure }) => {
      configure?.(new ListenerBuilder(definition), context)
      return definition
    })
  }
}

/** The configure kit a web application hands its features: the usual one, and a way to add a listener. */
export interface HTTPFeatureConfigureKit<C = unknown> extends FeatureConfigureKit<C> {
  readonly listeners: ListenerAdder<C, object>
}

/**
 * Lets a feature add a listener from its configure step, when the application installing it is a web application.
 *
 * `S` is the settings type the feature writes: `NodeServerSettings` for a `listen` section, which an adapter that
 * listens takes; an application under no adapter refuses it at start-up.
 *
 * ```ts
 * protected configure(kit: FeatureConfigureKit<C>): void {
 *   listenersOf<C, NodeServerSettings>(kit).add('metrics', l =>
 *     l.server(() => ({ listen: { port: this.#port } })).with(metrics()),
 *   )
 * }
 * ```
 *
 * @throws ErrConfiguration when the application is not a web application.
 */
export function listenersOf<C, S extends object = ServerSettings>(kit: FeatureConfigureKit<C>): ListenerAdder<C, S> {
  const listeners = (kit as Partial<HTTPFeatureConfigureKit<C>>).listeners

  if (listeners === undefined) {
    throw new ErrConfiguration(
      errMessage('Cannot add a listener: the application is not a web application')
        .solutions('Install the feature on createWebApplication()')
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  return listeners as ListenerAdder<C, S>
}
