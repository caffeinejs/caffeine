import { ErrApplicationClosed } from '@caffeinejs/application'
import type { Logger } from '@caffeinejs/application/logger'
import { contextKey, ContextStorage, Scopes, type Container, type ContextKey } from '@caffeinejs/di'
import { Second, type Duration } from '@caffeinejs/std/duration'

import type { HTTPSetupContext } from '../../plugin.js'
import type { IServer, ServerAddress } from '../../server.js'
import type { HookBatch } from '../lifecycle/batch.js'
import { findMyWayMatcher } from '../matcher/find_my_way.js'
import type { RouterFlags } from '../matcher/matcher.js'
import { rebaseMiddlewares } from '../middleware/path.js'
import type { MiddlewarePipeline, ResolvedMiddleware } from '../middleware/pipeline.js'
import type { RouteRecord } from '../routing/inventory.js'
import type { IRouteGroup, RouteGroupScope } from '../routing/route.js'
import { assertAuthorizationConfigured } from '../security/authz/index.js'
import { assertAuthenticationConfigured, assertRouteSchemesResolve } from '../security/security.js'
import { Context } from './context.js'
import { fetchPlatform } from './fetch.js'
import { requestInProcess } from './in_process.js'
import { HTTPServer } from './server.js'
import { resolveServerSettings, type ResolvedServerSettings, type ServerSettings } from './settings.js'

/**
 * The key of an adapter's hosting function: how it hosts each server. Kept out of the root barrel: an adapter takes it
 * from `@caffeinejs/http/platform`.
 */
export const kHosting: unique symbol = Symbol('@caffeinejs/http:hosting')

/** A server the application runs: the engine behind it, and its lifecycle. `L` is what its `run` listens with. */
export interface HostedServer<I = unknown, L = unknown> extends IServer<I> {
  /**
   * Starts listening, on a server that listens; resolves at once on one that does not. `options` is what `run(options)`
   * was given, for the application's own server; `undefined` for a listener.
   */
  run(options: L | undefined): Promise<void>
  teardown(): Promise<void>
  /** Abandons what is in flight, once the shutdown budget is spent. */
  forceTeardown(): Promise<void>
}

/** How an application hosts one server: the settings its engine runs with, and what serves the ready engine. */
export interface ServerHosting<I = unknown, L = unknown> {
  readonly settings: ResolvedServerSettings
  /** Whether the platform runs a Node middleware: one is refused at start-up otherwise. */
  readonly nodeMiddleware: boolean
  /**
   * `customize` runs the `serverCallback`s on the server: the adapter awaits it as soon as its server exists, and on a
   * failure closes what it built and rethrows.
   */
  serve(
    engine: HTTPServer,
    context: HTTPSetupContext,
    customize: (instance: NonNullable<I>) => Promise<void>,
  ): Promise<HostedServer<I, L>>
}

/**
 * What serves an application on a runtime: `node()` from `@caffeinejs/http-node`, `bun()` from `@caffeinejs/http/bun`.
 * `S` is what `.server(...)` returns under it, `I` what `app.instance` is, `L` what `run(options)` takes. An
 * application given none answers through `fetch` alone.
 */
export interface ServerAdapter<S extends object = object, I = unknown, L = never> {
  /** Never set: carries `S`, `I` and `L` for the application's types. */
  readonly __types?: { readonly settings: S; readonly instance: I; readonly listen: L }
  /** How one server is hosted, the application's own or a listener alike. */
  readonly [kHosting]: (settings: object) => ServerHosting<I, L>
}

/** Any adapter: a bare `WebApplication` takes an application under any of them. */
export type AnyServerAdapter = ServerAdapter<object, unknown, unknown>

/** What `.server(...)` returns under `A`. */
export type AdapterSettings<A extends AnyServerAdapter> = NonNullable<A['__types']>['settings']

/** What `app.instance` is under `A`. */
export type AdapterInstance<A extends AnyServerAdapter> = NonNullable<A['__types']>['instance']

/** What `run(options)` takes under `A`: `never` under an adapter that does not listen. */
export type AdapterListen<A extends AnyServerAdapter> = NonNullable<A['__types']>['listen']

/** The adapter an application gets when given none: no socket, answering through `app.fetch`. */
export type FetchAdapter = ServerAdapter<ServerSettings, undefined, never>

/** The adapter an application gets when given none. */
export const fetchAdapter: FetchAdapter = {
  [kHosting]: settings => ({
    settings: resolveServerSettings(settings),
    nodeMiddleware: false,
    serve: engine => Promise.resolve(new FetchServer(engine)),
  }),
}

/** How long an adapter that listens keeps an idle connection open: 72 seconds. */
export const IDLE_TIMEOUT: Duration = 72 * Second

/**
 * Where a server is bound, as {@link ServerAddress} describes it: `bound` is a Unix socket's path, or the address and
 * port of a TCP bind.
 */
export function addressOf(
  scheme: 'http' | 'https',
  bound: string | { readonly address: string; readonly port: number },
): ServerAddress {
  if (typeof bound === 'string') {
    return { host: '', port: 0, path: bound, origin: '' }
  }

  return { host: bound.address, port: bound.port, path: '', origin: originOf(scheme, bound.address, bound.port) }
}

/**
 * An origin for `host` that can be dialled: `0.0.0.0` and `::` are addresses to accept connections on, not addresses
 * to dial, so both map to their loopback equivalent; IPv6 is bracketed.
 */
function originOf(scheme: 'http' | 'https', host: string, port: number): string {
  if (host === '0.0.0.0') {
    return `${scheme}://127.0.0.1:${port}`
  }

  if (host === '::' || host === '::1') {
    return `${scheme}://[::1]:${port}`
  }

  return host.includes(':') ? `${scheme}://[${host}]:${port}` : `${scheme}://${host}:${port}`
}

/** Logs where a server listens, once it does: the same line under every adapter. */
export function logListening(logger: Logger, address: ServerAddress | undefined): void {
  const where = address === undefined ? '' : address.origin || address.path
  logger.info({ address: where }, `Server listening at ${where}`)
}

/**
 * What `app.listeners` hands out for `server`: what it is and where it listens, read on each access, but not its
 * lifecycle.
 */
export function viewOf<I>(server: IServer<I>): IServer<I> {
  return {
    get instance() {
      return server.instance
    },
    get address() {
      return server.address
    },
    request: (request, options) => server.request(request, options),
    fetch: (request, ...runtime) => server.fetch(request, ...runtime),
  }
}

/** Whether `value` is a server adapter: an object with a hosting function. */
export function isServerAdapter(value: unknown): value is AnyServerAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<Record<typeof kHosting, unknown>>)[kHosting] === 'function'
  )
}

/** What one server's engine is built from. */
export interface EngineInput {
  /** The slot the engine sets in each request's frame, from {@link bindContext}. */
  readonly contextKey: ContextKey<Context>
  readonly routeGroups: IRouteGroup<Context>[]
  /** The server's own context; its `container` and `logger` are the engine's. */
  readonly context: HTTPSetupContext
  readonly middlewares: MiddlewarePipeline
  /** The server's own `.with(...)` and `.hook(...)` entries, in the order written. */
  readonly root: readonly HookBatch[]
  /** What routers and controllers installed in front of their own routes. */
  readonly scoped: {
    batchesOf(scope: object): readonly HookBatch[]
    middlewaresOf(scope: object): readonly ResolvedMiddleware[]
  }
  readonly basePath: string | undefined
  readonly settings: ResolvedServerSettings
  readonly nodeMiddleware: boolean
  recordRoutes(routes: readonly RouteRecord[]): void
}

/** The router flags of an engine whose settings are `settings`, when it matches with find-my-way. */
export function findMyWayFlags(settings: ResolvedServerSettings): RouterFlags | undefined {
  return settings.matcher === findMyWayMatcher ? settings.router : undefined
}

/**
 * Binds `Context` request-scoped, read from the slot the engine sets in each request's frame, and returns that slot's
 * key. The key is this binding's own, so two applications on one storage never read each other's request.
 */
export function bindContext(container: Container): ContextKey<Context> {
  const key = contextKey<Context>('@caffeinejs/http:context')

  container.bind(Context, t =>
    t
      .toFunction((storage: ContextStorage) => storage.getStore()?.get(key) as Context, [ContextStorage])
      .lifetime(Scopes.REQUEST)
      .byPassPostProcessors()
      .internal(),
  )

  return key
}

/**
 * Builds the engine for one server: checks authentication and authorization, registers the routes with their hooks
 * and middleware, and records them.
 *
 * @throws ErrConfiguration for what the engine cannot serve.
 */
export function buildEngine(input: EngineInput): HTTPServer {
  const { container } = input.context
  const levels = {
    root: { batches: input.root, middlewares: input.middlewares.resolve(input.context) },
    of: (scope: RouteGroupScope) => ({
      batches: input.scoped.batchesOf(scope.key),
      middlewares: rebaseMiddlewares(scope.path, input.scoped.middlewaresOf(scope.key)),
    }),
  }

  assertAuthenticationConfigured(container, input.routeGroups)
  assertRouteSchemesResolve(container, input.routeGroups)
  assertAuthorizationConfigured(container, input.routeGroups)

  const server = new HTTPServer({
    routeGroups: input.routeGroups,
    settings: input.settings,
    basePath: input.basePath,
    container,
    contextKey: input.contextKey,
    logger: input.context.logger,
    levels,
    nodeMiddleware: input.nodeMiddleware,
  })

  input.recordRoutes(server.routes)

  return server
}

/** One server under no adapter: no socket of its own, answering what the runtime hands `fetch`. */
export class FetchServer implements HostedServer<undefined, never> {
  readonly #server: HTTPServer
  // Set once the teardown is over: a request() then rejects, while the runtime's fetch keeps the engine's 503.
  #closed = false

  constructor(server: HTTPServer) {
    this.#server = server
  }

  readonly fetch = (request: Request, ...runtime: unknown[]): Response | Promise<Response> =>
    this.#server.serve(fetchPlatform, request, runtime)

  get address(): ServerAddress | undefined {
    return undefined
  }

  get instance(): undefined {
    return undefined
  }

  request(input: Request | string | URL, options?: RequestInit): Promise<Response> {
    if (this.#closed) {
      return Promise.reject(new ErrApplicationClosed('reach the server'))
    }

    return requestInProcess(this.#server, input, options)
  }

  run(): Promise<void> {
    return Promise.resolve()
  }

  teardown(): Promise<void> {
    return this.#server.close().then(() => {
      this.#closed = true
    })
  }

  forceTeardown(): Promise<void> {
    this.#closed = true
    this.#server.forceClose()
    return Promise.resolve()
  }
}
