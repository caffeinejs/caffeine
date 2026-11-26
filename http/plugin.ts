import type { BootstrapKit } from '@caffeinejs/application'
import type { Container } from '@caffeinejs/di'

import type { HookFn, HookName } from './core/lifecycle/lifecycle.js'
import type { RouteMatcherFactory } from './core/matcher/matcher.js'
import type {
  MiddlewareFactory,
  MiddlewareFn,
  MiddlewareOptions,
  MiddlewarePath,
  MiddlewareResolvable,
} from './core/middleware/middleware.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import type { ServerAddress } from './server.js'

/**
 * The server a plugin is registered on, seen from where it is registered: what `context.server` is while a plugin
 * registers. Its scope is the server's `.with(...)`, one place a router is mounted at, or one controller: what the
 * plugin mounts, its middleware and its hooks cover that scope's routes and everything nested in it, never a sibling's.
 *
 * Its operations are open only while the plugin registers, its `.with(...)` factory and `HTTPPlugin.register`, and are
 * refused after; its identity stays readable.
 *
 * @throws ErrConfiguration from every operation called outside that registration, a context kept past it included.
 */
export interface ScopedServer<C = unknown> {
  /** The listener's name, as `.listener(name, ...)` added it; `undefined` for the application's own server. */
  readonly name: string | undefined

  /** The server's base path as `.basePath(...)` resolved it; `''` when it set none. */
  readonly basePath: string

  /**
   * Where this scope's routes start, after the base path: `''` for the server's `.with(...)`, and the router's or the
   * controller's full path otherwise. What `mount` adds nests under it.
   */
  readonly prefix: string

  /** The factory the server matches routes with: `findMyWayMatcher` unless `.server(...)` replaced it. */
  readonly matcher: RouteMatcherFactory

  /** Where the server listens; `undefined` until it does, and once it has closed. */
  readonly address: ServerAddress | undefined

  /**
   * Serves routers, compiled as `app.mount(...)` compiles them: the same guards, authorization, start-up checks and
   * routers' own plugins, and listed in a generated OpenAPI document unless a group is marked
   * `detail('http', { internal: true })`. The groups stay out of `app.routeGroups`, and a router mounted twice in
   * one place, or one the server already serves there, is served once.
   *
   * They nest under this scope's {@link prefix}: on the server's `.with(...)` the server serves them as mounted; on a
   * router they start from its path, guards and plugins; on a controller from its path and declarations, as a router
   * nested in a router starts from its parent's. A router nested in itself by `.mount(router)` or by this `mount`, the
   * same router again, is refused at start-up; one reached again through `.mount(path, router)` is not.
   */
  mount(...routers: AnyRouter[]): this

  /**
   * Adds a middleware, taking what `app.use(...)` takes. On the server's `.with(...)` it joins that server's pipeline,
   * after what the application's own `.use(...)` calls registered, and a path is the server's own. On a router or a
   * controller it runs in front of that router's or controller's routes alone, after its plugins, and a path is
   * relative to it: `use('/jobs', mw)` on a router at `/admin` covers `/admin/jobs`.
   *
   * @throws ErrConfiguration when a path is not a literal prefix.
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

  /**
   * Adds a factory that builds a middleware once at start-up, as `app.useFn(...)` does, where `use` would put it.
   *
   * @throws ErrConfiguration when a path is not a literal prefix.
   */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions): this

  /**
   * Adds a hook, in this plugin's place among the plugins of its scope. A request hook covers the scope's routes; a
   * server hook runs once per server, handed the context the plugin registered with.
   *
   * @throws ErrConfiguration for a point that is not a hook.
   */
  hook<K extends HookName>(name: K, fn: HookFn<K, C>): this

  /**
   * Whether a plugin of that name was registered earlier in this scope or in one it is nested in: the routers or the
   * controller around it, then the server.
   */
  hasPlugin(name: string): boolean
}

/**
 * What an HTTP application hands everything it builds at start-up: a plugin factory, a middleware factory, a
 * feature's server hook.
 *
 * Built once the container has initialized, so `container.get(...)` is legal, and `logger` is the one the logger
 * feature configured.
 */
export interface HTTPSetupContext<C = unknown> extends BootstrapKit<C> {
  container: Container

  /**
   * Whether `.install(...)` recorded a feature under this name, the framework's built-ins included. A plugin
   * that depends on a feature's bindings asks it in its factory or in `register(context)`.
   */
  hasFeature(name: string): boolean

  /**
   * The server this plugin is registered on, scoped to where it is registered: what it mounts, its middleware and its
   * hooks cover that scope. Defined in every plugin factory and `register`; a callback that runs before the server
   * exists, such as `.server(...)`, gets a context without it.
   */
  server: ScopedServer<C>
}

/**
 * Produces a plugin from what the application resolved at start-up: what `.with(...)`, `router.with(...)` and
 * `@Use(...)` take.
 *
 * Called after the container has initialized, once per scope it is declared in: a router's or a controller's factory
 * runs once on each server serving it, per place the router is mounted at. Never deduplicated: two factories install
 * two plugins.
 */
export type HTTPPluginFactory<C = unknown> = (context: HTTPSetupContext<C>) => HTTPPlugin | Promise<HTTPPlugin>

declare const kHTTPPlugin: unique symbol

/**
 * A server plugin: what a `.with(...)` factory returns.
 *
 * {@link register} does the plugin's work, handed the same {@link HTTPSetupContext} the factory got:
 * `context.container` resolves, `context.hasFeature(name)` lets a plugin that depends on a feature refuse a missing
 * one with `ErrFeatureNotInstalled`, and `context.server`, the server it is registered on, mounts routers, adds
 * middleware and adds hooks: `context.server.hook('onSend', ...)`. Never deduplicated: two factories register two
 * plugins, and two over one route both run. Register a plugin once, where it covers the routes it should; routes tune
 * it through their options. A package exporting one types its factory `HTTPPluginFactory<C>`. A plugin extends this
 * class: a plain object with a `register` method is refused by the compiler and at start-up.
 *
 * Where it is registered decides what `context.server` reaches:
 *
 * - With `.with(...)` on the application, or `.listener(name, l => l.with(...))`, it registers on that server: what it
 *   mounts that server serves, and its middleware joins that server's pipeline.
 * - With `router.with(...)`, it registers on each server the router is mounted on, once per place, after that
 *   server's own plugins: what it mounts nests under the router, and its middleware runs in front of the router's
 *   routes, with paths relative to the router.
 * - With `@Use(...)` on a controller, it registers on the server serving the controller, after the routers' plugins:
 *   what it mounts nests under the controller, and its middleware runs in front of the controller's routes, with paths
 *   relative to the controller.
 *
 * ```ts
 * class Metrics extends HTTPPlugin {
 *   register({ server, container }: HTTPSetupContext): void {
 *     const registry = container.get(MetricsRegistry)
 *     server.mount(new Router('/metrics').get('/', () => registry.render()))
 *   }
 * }
 *
 * app.with(() => new Metrics())
 * app.listener('admin', l => l.with(() => new Metrics()))
 * ```
 */
export abstract class HTTPPlugin {
  // Makes the type nominal: an object with a register method is not a plugin, and the compiler says so.
  declare private readonly [kHTTPPlugin]: true

  /** What `context.server.hasPlugin(name)` answers to. An empty name is refused. */
  readonly name?: string

  abstract register(context: HTTPSetupContext): void | Promise<void>
}

/**
 * Authors a plugin's options through its builder, handed the same {@link HTTPSetupContext} the factory that
 * runs it was given — so a plugin's settings can come from the application's configuration or from something
 * it resolves out of the container.
 *
 * Runs while the factory builds the plugin, after `container.init()`, so `container.get(...)` is legal and
 * `container.bind(...)` is not. A feature's callback is `FeatureConfigurer` from `@caffeinejs/application` instead,
 * which runs earlier and binds rather than resolves.
 *
 * ```ts
 * .with(HTTPCaching((b, { container }) => b.store(container.get(RedisCache))))
 * ```
 */
export type HTTPPluginConfigurer<B, C = unknown> = (builder: B, context: HTTPSetupContext<C>) => void
