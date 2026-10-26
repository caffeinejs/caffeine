import type { BootstrapKit } from '@caffeinejs/application'
import type { Container } from '@caffeinejs/di'

import type {
  MiddlewareFactory,
  MiddlewareFn,
  MiddlewareOptions,
  MiddlewarePath,
  MiddlewareResolvable,
  Next,
  NodeMiddleware,
} from './core/middleware/middleware.js'
import type { MiddlewarePipeline, ResolvedMiddleware } from './core/middleware/pipeline.js'
import type { RouteGroupCompiler } from './core/routing/compile.js'
import type { RouteRecord } from './core/routing/inventory.js'
import type { Router } from './core/routing/programmatic/programmatic.js'
import type { IRouteGroup } from './core/routing/route.js'
import type { IServer } from './server.js'

/** What `ctx.platform` is at least. `name` says which server library serves the request. */
export interface IContextPlatform {
  readonly name: string
}

/**
 * Every type that belongs to the server library behind an adapter, named once.
 *
 * An adapter declares one of these. The application, its routers and each request's context read their
 * server-specific types off it, so a new one is a new member here rather than a new type parameter everywhere.
 */
export interface IAdapterTypes {
  /** The server the adapter drives, which is what the application's `instance` is. */
  instance: unknown

  /** The request routes are compiled against. */
  request: unknown

  /** What `.with(factory)`, `router.with(...)` and `@Use(...)` install. `never` when the server takes none. */
  extension: unknown

  /** The request-lifecycle points `app.use(..., { hook })` accepts. `never` when the server has none. */
  hook: string

  /** What `ctx.req.raw` is. */
  raw: unknown

  /** What `ctx.cookie(...)` and `ctx.deleteCookie(...)` take as options. */
  cookieOptions: unknown

  /** Whether `ctx.req.signedCookie(...)` and `ctx.req.unsignCookie(...)` answer with a promise. */
  asyncCookies: boolean

  /** What `ctx.platform` is. */
  platform: IContextPlatform

  /**
   * What `.server(configure)` resolves to: the server's construction and listen settings, in the sections the
   * adapter names. Several calls shallow-merge section by section, in call order.
   */
  serverOptions: object

  /** What `app.run(...)` takes and hands `IAdapterServer.run(...)` untouched. `[]` when the server takes nothing. */
  runArgs: readonly unknown[]
}

/**
 * The adapters loaded in this compilation, by name. An adapter package adds its own entry:
 *
 * ```ts
 * declare module '@caffeinejs/http' {
 *   interface AdapterRegistry {
 *     mine: MyAdapterTypes
 *   }
 * }
 * ```
 *
 * Code written without knowing its adapter is typed against every entry at once: `@Use(...)` takes any registered
 * extension, and `ctx.platform` on a plain `IContext` is any registered platform. With more than one entry, a
 * reader narrows on `ctx.platform.name` first. The Fastify entry is declared by `@caffeinejs/http/fastify`.
 */
export interface AdapterRegistry {}

/** Any registered adapter's types. */
export type AnyAdapterTypes = AdapterRegistry[keyof AdapterRegistry]

/** What any registered adapter installs. */
export type AnyAdapterExtension = AnyAdapterTypes['extension']

/**
 * Where the server ended up listening, as reported by the bound socket — which is not what was asked for:
 * port `0` becomes an OS-assigned port, and a wildcard host stays a wildcard.
 */
export interface ServerAddress {
  /** The bound host, verbatim — a wildcard bind reports `0.0.0.0` or `::`. `''` on a unix socket or a named pipe. */
  readonly host: string
  /** The bound port. Never `0` on a TCP bind, and `0` on a unix socket or a named pipe. */
  readonly port: number
  /** The unix socket or the named pipe the server is bound to. `''` on a TCP bind. */
  readonly path: string
  /**
   * An origin that can be connected to: `https:` when the server serves TLS, `http:` otherwise. A wildcard
   * {@link host} is rendered as the matching loopback address, since `0.0.0.0` is an address to accept on, not one
   * to dial. `''` on a unix socket or a named pipe, which no URL reaches.
   */
  readonly origin: string
}

/**
 * The callback `.server(configure)` takes: resolves the server's settings against the same context a plugin
 * factory gets, so `config` is the resolved tree and the container resolves. Returns the adapter's own shape —
 * under Fastify, `{ factory, listener }`.
 */
export type ServerConfigurer<T extends IAdapterTypes, C = unknown> = (
  context: HTTPSetupContext<C>,
) => T['serverOptions'] | Promise<T['serverOptions']>

/**
 * The callback `.serverCallback(...)` takes: handed the same context a plugin factory gets, then the server right
 * after the adapter constructs it, before anything is decorated or registered on it.
 */
export type ServerCustomizer<T extends IAdapterTypes, C = unknown> = (
  context: HTTPSetupContext<C>,
  instance: T['instance'],
) => void | Promise<void>

/** What an application hands its adapter to set one server up with. */
export interface AdapterIn<T extends IAdapterTypes> {
  routeGroups: IRouteGroup<T['request']>[]
  /**
   * What `$route` compiles a late group with: the compiler {@link buildRouting} built the groups above with, applied
   * the way this server applies it to every group it serves.
   */
  compileRouteGroup: RouteGroupCompiler
  /** What the application hands everything it builds at start-up. The middleware factories run against it. */
  context: HTTPSetupContext
  /** What `app.use()` registered, for the adapter to resolve and attach to its hooks. */
  middlewares: MiddlewarePipeline<T['hook']>
  /**
   * What the `.with(...)` factories contributed, in install order. The adapter installs its own error handling and
   * cookies ahead of them, from what the error-handling and cookie features bound.
   */
  extensions: AdapterExtensions<T['extension']>
  /** What every `.server(configure)` resolved to, merged section by section. Empty when none was made. */
  server: T['serverOptions']
  /** Every `.serverCallback(...)` callback folded into one that runs them in call order. `undefined` when none. */
  customize: ServerCustomizer<T> | undefined
  /**
   * What `.basePath(...)` resolved to, normalized: `/api`, never `/api/`. `undefined` when the application set
   * none. The adapter strips it from a request's path before routing, and reports it as `ctx.req.basePath`.
   */
  basePath: string | undefined
  /**
   * Hands the server's routes to the application's `RouteInventory`, once every route has registered and before
   * the server is ready. Called once.
   */
  recordRoutes(routes: readonly RouteRecord[]): void
}

/**
 * Builds the servers behind a {@link WebApplication}. `T` names every type that belongs to the server library, and is
 * what the application, its routers and each request's context are typed with.
 */
export interface IAdapter<T extends IAdapterTypes> {
  /**
   * Builds one server from `input.server`, hands it to `input.customize`, then wires everything else onto it. The
   * server comes back ready and not listening.
   *
   * Each call builds a server of its own, sharing nothing with another but the adapter's request context: the
   * application calls it for its own server, and once more for every other server it runs.
   */
  setup(input: AdapterIn<T>): Promise<IAdapterServer<T>>
}

/** A server an {@link IAdapter} built, lifecycle included: whoever asked for it runs it and tears it down. */
export interface IAdapterServer<T extends IAdapterTypes> extends IServer<T> {
  /**
   * Starts listening on the settings the server was built with. The application hands its own server what
   * {@link WebApplication.run} was given, untouched, and any other server nothing.
   *
   * Once it resolves, `address` is set until {@link teardown}.
   */
  run(...args: T['runArgs']): Promise<void>

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

export type AdapterFactory<T extends IAdapterTypes> = (input: AdapterFactoryIn) => IAdapter<T>

/**
 * The application's operations a plugin may drive while it registers: what `context.app` is on an
 * {@link HTTPSetupContext}. Scoped to the server the plugin is registered on, or, for a router's or a controller's
 * plugin, to that router or controller.
 *
 * `T` is the adapter whose routers and hooks it takes. `never`, for code written without knowing its adapter, takes
 * routers bound to no adapter and names no hook.
 *
 * Open only while the plugin's slot runs: its `.with(...)` factory and `HTTPPlugin.register`.
 *
 * @throws ErrConfiguration from every call made outside that slot, a context kept past it included.
 */
export interface WebApplicationOps<T extends IAdapterTypes = never, C = unknown> {
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
  mount(...routers: Router<any, any, any, any, any, T>[]): this

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

  /** Adds a factory that builds a middleware once at start-up, as `app.useFn(...)` does, where `use` would put it. */
  useFn(target: MiddlewareFactory<C>, options?: MiddlewareOptions<T['hook']>): this
  useFn(path: MiddlewarePath, target: MiddlewareFactory<C>, options?: MiddlewareOptions<T['hook']>): this
}

/**
 * What an HTTP application hands everything it builds at start-up: an extension factory, a middleware factory, a
 * feature's server hook.
 *
 * Built once the container has initialized, so `container.get(...)` is legal, and `logger` is the one the logger
 * feature configured.
 */
export interface HTTPSetupContext<C = unknown, T extends IAdapterTypes = never> extends BootstrapKit<C> {
  container: Container

  /**
   * Whether `.install(...)` recorded a feature under this name, the framework's built-ins included. What a
   * plugin factory that depends on a feature's bindings asks before the server exists; a plugin body asks the
   * instance's `$hasFeature(...)` instead.
   */
  hasFeature(name: string): boolean

  /**
   * What a plugin may do to the application while it registers: mount routers and add middleware. Every call
   * outside a plugin's slot throws.
   */
  app: WebApplicationOps<T, C>
}

/**
 * Produces what an adapter installs on its server from what the application resolved at start-up. Under the
 * Fastify adapter that is a plugin: see `HTTPPluginFactory`.
 *
 * What `.with(...)` takes, and what `router.with(...)` and `@Use(...)` take. Called once, after the container
 * has initialized. Never deduplicated: two factories install two extensions.
 */
export type AdapterExtensionFactory<X, C = unknown, T extends IAdapterTypes = never> = (
  context: HTTPSetupContext<C, T>,
) => X | Promise<X>

/**
 * What an application hands its adapter to install.
 *
 * The root list is in the order the application wrote its `.with(...)` calls, and that order is the whole ordering
 * model: an adapter installs the extensions one at a time, each finished before the next starts. What a router or a
 * controller asked for is kept apart, per scope, for the adapter to install in front of that scope's routes alone:
 * its plugins, then the middleware its plugins added.
 */
export class AdapterExtensions<X> {
  readonly #root: X[] = []
  readonly #scoped = new Map<object, X[]>()
  readonly #middlewares = new Map<object, readonly ResolvedMiddleware[]>()

  /** Adds an extension to the list of `scope`, a router or a controller class. */
  add(extension: X, scope: object): void {
    let scoped = this.#scoped.get(scope)
    if (scoped === undefined) {
      scoped = []
      this.#scoped.set(scope, scoped)
    }

    scoped.push(extension)
  }

  /** What the application installs on the root server, in the order it was written. */
  root(): readonly X[] {
    return this.#root
  }

  /** What `scope`, a mounted router or a controller class, installs in front of its own routes. */
  of(scope: object): readonly X[] {
    return this.#scoped.get(scope) ?? []
  }

  /**
   * Records the middleware a router's or a controller's plugins added, run in front of its routes after its plugins.
   * Paths are relative to it: the adapter rebases them under each group's `RouteGroupScope.path`.
   */
  addMiddlewares(scope: object, middlewares: readonly ResolvedMiddleware[]): void {
    this.#middlewares.set(scope, middlewares)
  }

  /** What `scope` runs in front of its own routes. */
  middlewaresOf(scope: object): readonly ResolvedMiddleware[] {
    return this.#middlewares.get(scope) ?? []
  }

  /**
   * The scoped extensions registered so far, in front of another root list: what one more server installs when it
   * serves groups of the same routers and controllers.
   */
  withRoot(root: readonly X[]): AdapterExtensions<X> {
    const extensions = new AdapterExtensions<X>()
    extensions.#root.push(...root)

    for (const [scope, scoped] of this.#scoped) {
      extensions.#scoped.set(scope, scoped)
    }

    for (const [scope, middlewares] of this.#middlewares) {
      extensions.#middlewares.set(scope, middlewares)
    }

    return extensions
  }
}
