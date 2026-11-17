import type { BootstrapKit } from '@caffeinejs/application'
import type { Container } from '@caffeinejs/di'

import type { HookFn, HookName } from './core/lifecycle/lifecycle.js'
import type { RouterFlags } from './core/matcher/matcher.js'
import type {
  MiddlewareFactory,
  MiddlewareFn,
  MiddlewareOptions,
  MiddlewarePath,
  MiddlewareResolvable,
  Next,
  NodeMiddleware,
} from './core/middleware/middleware.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'

/**
 * The application's operations a plugin may drive while it registers: what `context.app` is on an
 * {@link HTTPSetupContext}. Scoped to the server the plugin is registered on, or, for a router's or a controller's
 * plugin, to that router or controller.
 *
 * Open only while the plugin's slot runs: its `.with(...)` factory and `HTTPPlugin.register`.
 *
 * @throws ErrConfiguration from every call made outside that slot, a context kept past it included.
 */
export interface WebApplicationOps<C = unknown> {
  /**
   * Serves routers, compiled as `app.mount(...)` compiles them: the same guards, authorization, start-up checks and
   * routers' own plugins, and listed in a generated OpenAPI document unless a group is marked
   * `detail('http', { internal: true })`. The groups stay out of `app.routeGroups`, and a router mounted twice in
   * one place, or one the application already serves on that server, is served once.
   *
   * On a server, the server serves them, and a router bound with `bindTo` to another server is refused at
   * start-up. On a router, they nest under it, starting from its path, binding, guards and plugins. A controller's
   * plugin cannot mount: a class has no children to nest routers under. A router nested in itself, through any of
   * these mounts, is refused at start-up.
   */
  mount(...routers: AnyRouter[]): this

  /**
   * Adds a middleware, taking what `app.use(...)` takes. On a server it joins that server's pipeline, after what the
   * application's own `.use(...)` calls registered, and a path is the server's own. On a router or a controller it
   * runs in front of that router's or controller's routes alone, after its plugins, and a path is relative to it:
   * `use('/jobs', mw)` on a router at `/admin` covers `/admin/jobs`.
   *
   * @throws ErrConfiguration from start-up, for a relative path under a router whose path holds a wildcard or an
   *   optional parameter: neither has a prefix to start from.
   */
  use<V = Record<never, never>, Conf = Record<never, never>>(
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions,
  ): this
  use(target: NodeMiddleware, options?: MiddlewareOptions): this
  use(target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions): this
  use(target: MiddlewareResolvable, options?: MiddlewareOptions): this
  use<V = Record<never, never>, Conf = Record<never, never>>(
    path: MiddlewarePath,
    target: MiddlewareFn<V, Conf>,
    options?: MiddlewareOptions,
  ): this
  use(path: MiddlewarePath, target: NodeMiddleware, options?: MiddlewareOptions): this
  use(path: MiddlewarePath, target: (req: never, res: never, next: Next) => void, options?: MiddlewareOptions): this
  use(path: MiddlewarePath, target: MiddlewareResolvable, options?: MiddlewareOptions): this

  /** Adds a factory that builds a middleware once at start-up, as `app.useFn(...)` does, where `use` would put it. */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions): this

  /**
   * Adds a hook, in this plugin's place among the plugins of its slot. On a server a request hook covers every route
   * that server serves; on a router or a controller, that one's routes. A server hook runs once per server, handed the
   * context the plugin registered with.
   *
   * @throws ErrConfiguration for a point that is not a hook.
   */
  hook<K extends HookName>(name: K, fn: HookFn<K, C>): this

  /**
   * Whether a plugin of that name was registered earlier in this slot: this server's, router's or controller's. A
   * router's plugins register once, before any server's, so they never see a server's plugins.
   */
  hasPlugin(name: string): boolean

  /**
   * The server this slot registers on: its base path as `.basePath(...)` resolved it, `''` when it set none.
   * `undefined` in a router's or a controller's slot, which every server serving it shares, and in the server's own
   * `.server(...)` and `.basePath(...)` callbacks, which run before it is known.
   *
   * `router` is the flags its router matches paths with, as `.server(...)` set them, when the server matches with
   * find-my-way; `undefined` under a matcher of its own.
   */
  readonly server: SlotServer | undefined
}

/** The server a plugin slot registers on, as {@link WebApplicationOps.server} reports it. */
export interface SlotServer {
  readonly basePath: string
  readonly router: RouterFlags | undefined
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
   * What a plugin may do to the application while it registers: mount routers, add middleware and hooks, and ask
   * `hasPlugin`. Every call outside a plugin's slot throws.
   */
  app: WebApplicationOps<C>
}

/**
 * Produces a plugin from what the application resolved at start-up: what `.with(...)`, `router.with(...)` and
 * `@Use(...)` take.
 *
 * Called once, after the container has initialized. Never deduplicated: two factories install two plugins.
 */
export type HTTPPluginFactory<C = unknown> = (context: HTTPSetupContext<C>) => HTTPPlugin | Promise<HTTPPlugin>

/**
 * A server plugin: what a `.with(...)` factory returns.
 *
 * {@link register} does the plugin's work, handed the same {@link HTTPSetupContext} the factory got:
 * `context.container` resolves, `context.hasFeature(name)` lets a plugin that depends on a feature refuse a missing
 * one with `ErrFeatureNotInstalled`, and `context.app` mounts routers, adds middleware and adds hooks:
 * `context.app.hook('onSend', ...)`. Never deduplicated: two factories register two plugins. A package
 * exporting one types its factory `HTTPPluginFactory<C>`.
 *
 * Where it is registered decides what `context.app` reaches:
 *
 * - With `.with(...)` on the application, or `.listener(name, l => l.with(...))`, it registers in that slot, before the
 *   server is built: what it mounts that server serves, and its middleware joins that server's pipeline.
 * - With `router.with(...)`, it registers once during start-up, before routing is built: what it mounts nests under
 *   the router, and its middleware runs in front of the router's routes, with paths relative to the router.
 * - With `@Use(...)` on a controller, its middleware runs in front of the controller's routes, with paths relative
 *   to the controller. It cannot mount: a class has no children to nest routers under.
 *
 * ```ts
 * class Metrics extends HTTPPlugin {
 *   register({ app, container }: HTTPSetupContext): void {
 *     const registry = container.get(MetricsRegistry)
 *     app.mount(new Router('/metrics').get('/', () => registry.render()))
 *   }
 * }
 *
 * app.with(() => new Metrics())
 * app.listener('admin', l => l.with(() => new Metrics()))
 * ```
 */
export abstract class HTTPPlugin {
  /**
   * What `context.app.hasPlugin(name)` answers to. A named plugin is refused twice in one slot, a server's, a router's
   * or a controller's, and allowed once in each of several. An empty name is refused.
   */
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
