import type { Container } from '@caffeinejs/di'
import type { BootstrapKit } from '@caffeinejs/std'

import type { MiddlewarePipeline } from './middleware/pipeline.js'
import type { RouteGroupCompiler } from './routing/compile.js'
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

  /** Whether `ctx.req.signedCookie(...)` answers with a promise. */
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
 * The callback `.serverCallback(...)` takes: handed the same context a plugin factory gets, then the server right
 * after the adapter constructs it, before anything is decorated or registered on it.
 */
export type ServerCustomizer<T extends AdapterTypes, C = unknown> = (
  context: HTTPSetupContext<C>,
  instance: T['instance'],
) => void | Promise<void>

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
  /** Every `.serverCallback(...)` callback folded into one that runs them in call order. `undefined` when none. */
  customize: ServerCustomizer<T> | undefined
  /**
   * What `.basePath(...)` resolved to, normalized: `/api`, never `/api/`. `undefined` when the application set
   * none. The adapter strips it from a request's path before routing, and reports it as `ctx.req.basePath`.
   */
  basePath: string | undefined
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

/**
 * What an HTTP application hands everything it builds at start-up: an extension factory, a middleware factory, a
 * feature's server hook.
 *
 * Built once the container has initialized, so `container.get(...)` is legal, and `logger` is the one the logger
 * feature configured.
 */
export interface HTTPSetupContext<C = unknown> extends BootstrapKit<C> {
  container: Container
}

/**
 * Produces what an adapter installs on its server from what the application resolved at start-up. Under the
 * Fastify adapter that is a plugin: see `HTTPPluginFactory`.
 *
 * What `.with(...)` takes when its argument is a function, and what `router.plugin(...)` and `@Use(...)` take.
 * Called once, after the container has initialized. Never deduplicated: two factories install two extensions.
 */
export type AdapterExtensionFactory<X, C = unknown> = (context: HTTPSetupContext<C>) => X | Promise<X>

/** One slot on the root server: an extension a factory produced, or a feature's server hook. */
export type AdapterExtensionEntry<I, X> =
  | { readonly kind: 'extension'; readonly extension: X }
  | { readonly kind: 'feature'; readonly name: string; readonly install: (instance: I) => void | Promise<void> }

/**
 * What an application hands its adapter to install.
 *
 * The root list is in the order the application wrote its `.with(...)` calls, and that order is the whole ordering
 * model: an adapter installs the entries one at a time, each finished before the next starts. What a router or a
 * controller asked for is kept apart, per scope, for the adapter to install in front of that scope's routes alone.
 */
export class AdapterExtensions<I, X> {
  readonly #root: AdapterExtensionEntry<I, X>[] = []
  readonly #scoped = new Map<object, X[]>()

  /** Adds an extension to the root list, or, given a router or a controller class, to that scope's own. */
  add(extension: X, scope?: object): void {
    if (scope === undefined) {
      this.#root.push({ kind: 'extension', extension })
      return
    }

    let scoped = this.#scoped.get(scope)
    if (scoped === undefined) {
      scoped = []
      this.#scoped.set(scope, scoped)
    }

    scoped.push(extension)
  }

  /** Adds a feature's server hook to the root list. */
  addFeature(name: string, install: (instance: I) => void | Promise<void>): void {
    this.#root.push({ kind: 'feature', name, install })
  }

  /** What the application installs on the root server, in the order it was written. */
  root(): readonly AdapterExtensionEntry<I, X>[] {
    return this.#root
  }

  /** What `scope`, a mounted router or a controller class, installs in front of its own routes. */
  of(scope: object): readonly X[] {
    return this.#scoped.get(scope) ?? []
  }
}
