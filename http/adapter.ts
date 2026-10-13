import type { Container } from '@caffeinejs/di'
import type { BootstrapKit } from '@caffeinejs/std'

import type { MiddlewarePipeline } from './middleware/pipeline.js'
import type { Router } from './routing/programmatic/router.js'
import type { RouteGroup } from './routing/route.js'

/** What `ctx.platform` is at least. `name` says which server library serves the request. */
export interface ContextPlatform {
  readonly name: string
}

/**
 * Every type that belongs to the server library behind an adapter, named once.
 *
 * An adapter declares one of these. The application, its routers and each request's context read their
 * server-specific types off it, so a new one is a new member here rather than a new type parameter everywhere.
 */
export interface AdapterTypes {
  /** The server the adapter drives, which is what the application's `instance` is. */
  instance: unknown

  /** The request routes are compiled against. */
  request: unknown

  /** What `.with(factory)`, `router.plugin(...)` and `@Use(...)` install. `never` when the server takes none. */
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
  platform: ContextPlatform

  /**
   * What `.server(configure)` resolves to: the server's construction and listen settings, in the sections the
   * adapter names. Several calls shallow-merge section by section, in call order.
   */
  serverOptions: object

  /** What `app.run(...)` takes and hands `Adapter.run(...)` untouched. `[]` when the server takes nothing. */
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
 * extension, and `ctx.platform` on a plain `Context` is any registered platform. With more than one entry, a
 * reader narrows on `ctx.platform.name` first. The Fastify entry is declared by this package's root entry point.
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
  /** The bound host, verbatim — a wildcard bind reports `0.0.0.0` or `::`. */
  readonly host: string
  /** The bound port. Never `0`. */
  readonly port: number
  /**
   * An origin that can be connected to: `https:` when the server serves TLS, `http:` otherwise. A wildcard
   * {@link host} is rendered as the matching loopback address, since `0.0.0.0` is an address to accept on, not one
   * to dial.
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
 * The callback `.serverCallback(...)` takes: handed the same context a plugin factory gets, then the server right
 * after the adapter constructs it, before anything is decorated or registered on it.
 */
export type ServerCustomizer<T extends AdapterTypes, C = unknown> = (
  context: HTTPSetupContext<C>,
  instance: T['instance'],
) => void | Promise<void>

/** What an application hands its adapter to set one server up with. */
export interface AdapterIn<T extends AdapterTypes> {
  /**
   * Routes this server and resolves to the groups to register on it, in order: compiled, checked at start-up and
   * listed in the route table.
   *
   * Call it once, after installing `extensions.root()` and before registering a route: until then the plugins being
   * installed may still mount routers on this server. By the time it resolves, `extensions.of(scope)` answers for every
   * scope its groups name. It rejects when the server cannot be routed: a router bound to a server that does not serve
   * it, a route that cannot compile, a protected route nothing authenticates.
   */
  route(): Promise<readonly RouteGroup<T['request']>[]>
  /** What the application hands everything it builds at start-up. The middleware factories run against it. */
  context: HTTPSetupContext
  /** What `app.use()` registered, for the adapter to resolve and attach to its hooks. */
  middlewares: MiddlewarePipeline<T['hook']>
  /** What the application's head slots and `.with(...)` factories contributed, in install order. */
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
}

/**
 * Builds the servers behind a {@link WebApplication}. `T` names every type that belongs to the server library, and is
 * what the application, its routers and each request's context are typed with.
 */
export interface Adapter<T extends AdapterTypes> {
  /**
   * Builds one server: constructs it from `input.server`, hands it to `input.customize`, installs
   * `input.extensions.root()` in order, calls `input.route()` once, then registers the groups it resolved to, each
   * behind what `input.extensions.of(scope)` names for its scopes. The server comes back ready and not listening.
   *
   * Each call builds a server of its own, sharing nothing with another but the adapter's request context: the
   * application calls it for its own server, and once more for every other server it runs. The application refuses a
   * server whose adapter never called `input.route()`, or called it twice.
   */
  setup(input: AdapterIn<T>): Promise<AdapterServer<T>>
}

/** A server an {@link Adapter} built. Whoever asked for it runs it and tears it down. */
export interface AdapterServer<T extends AdapterTypes> {
  get instance(): T['instance']

  /** Where the server is listening, or `undefined` before {@link run} and after {@link teardown}. */
  get address(): ServerAddress | undefined

  /**
   * Starts listening on the settings the server was built with. The application hands its own server what
   * {@link WebApplication.run} was given, untouched, and any other server nothing.
   */
  run(...args: T['runArgs']): Promise<void>
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

/**
 * What an HTTP application hands everything it builds at start-up: an extension factory, a middleware factory, a
 * feature's server hook.
 *
 * Built once the container has initialized, so `container.get(...)` is legal, and `logger` is the one the logger
 * feature configured.
 */
export interface HTTPSetupContext<C = unknown> extends BootstrapKit<C> {
  container: Container

  /**
   * Whether `.install(...)` recorded a feature under this name, the framework's built-ins included. What a
   * plugin factory that depends on a feature's bindings asks before the server exists; a plugin body asks the
   * instance's `$hasFeature(...)` instead.
   */
  hasFeature(name: string): boolean

  /**
   * The application's compiled route table, the groups `app.routeGroups` holds: every group its controllers declared
   * and every router mounted on it, the ones plugin factories mounted through {@link HTTPSetupContext.app} included,
   * on every server, with `boundTo` naming the ops server a group is bound to.
   *
   * Filled server by server as each is routed: the application's own first, then each ops server in install order. A
   * server is routed once its plugins have loaded, so its factories and the plugins they return see the servers routed
   * before it, while its hooks and its handlers see it too. Complete before the application listens, and filled in
   * place, so a reference taken earlier stays current.
   *
   * A route a plugin registers straight on a server is not in it: a plugin reads what its own server registers with
   * `collectRouteGroups(instance)`.
   */
  readonly routeGroups: readonly RouteGroup<unknown>[]

  /** The application, for a plugin factory to mount routers on: see {@link SetupApplication}. */
  readonly app: SetupApplication
}

/** What {@link HTTPSetupContext.app} is: the application, as what it builds at start-up may use it. */
export interface SetupApplication {
  /**
   * Mounts routers on the server the context belongs to: compiled, checked at start-up and protected like every
   * router the application mounts. Returns this, so a plugin factory that installs nothing else hands it back:
   * `({ app }) => app.mount(router)`.
   *
   * Open until that server's routing pass: its `.server(...)`, `.basePath(...)` and `.serverCallback(...)` callbacks,
   * its `.with(...)` factories, and the plugins those return, async or callback-style, while they load. A router that
   * names no server is served on this one. On the application's own server, a router bound with `bindTo(name)` is
   * served on that ops server; on an ops server, one bound to another server fails `bootstrap()`.
   *
   * A mount once that server is routed, from a hook, a router's or a controller's plugin, or another server's plugin,
   * is refused. During start-up the refusal is never thrown, since a throw from a callback-style plugin's body would
   * end the process: it fails `bootstrap()` once the server being set up is built.
   *
   * @throws ErrConfiguration once the application has started.
   */
  readonly mount: (...routers: Router<any, any, any, any, any, any>[]) => SetupApplication
}

/**
 * Produces what an adapter installs on its server from what the application resolved at start-up. Under the
 * Fastify adapter that is a plugin: see `HTTPPluginFactory`.
 *
 * What `router.plugin(...)` and `@Use(...)` take. `.with(...)` takes one that may hand back `context.app` instead,
 * when all it does is mount routers: `AdapterExtensionFactory<X | SetupApplication>`. Called once, after the
 * container has initialized. Never deduplicated: two factories install two extensions.
 */
export type AdapterExtensionFactory<X, C = unknown> = (context: HTTPSetupContext<C>) => X | Promise<X>

/**
 * What an application hands its adapter to install.
 *
 * The root list is in the order the application wrote its `.with(...)` calls, after the framework's own head
 * slots, and that order is the whole ordering model: an adapter installs the extensions one at a time, each
 * finished before the next starts. What a router or a controller asked for is kept apart, per scope, for the
 * adapter to install in front of that scope's routes alone.
 */
export class AdapterExtensions<X> {
  readonly #root: X[] = []
  #scoped = new Map<object, X[]>()

  /** Adds an extension to the root list, or, given a router or a controller class, to that scope's own. */
  add(extension: X, scope?: object): void {
    if (scope === undefined) {
      this.#root.push(extension)
      return
    }

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
   * Another server's view: a root list of its own, and the scoped extensions, shared with this one rather than
   * copied, so what a later routing pass adds for a scope reaches every view.
   */
  withRoot(root: readonly X[]): AdapterExtensions<X> {
    const extensions = new AdapterExtensions<X>()
    extensions.#root.push(...root)
    extensions.#scoped = this.#scoped

    return extensions
  }
}
