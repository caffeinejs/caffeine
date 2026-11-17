import { ErrApplicationClosed } from '@caffeinejs/application'
import { contextKey, ContextStorage, Scopes, type Container, type ContextKey } from '@caffeinejs/di'

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
import type { ResolvedServerSettings } from './settings.js'

/** The method key of how an application hosts its servers. Kept out of every barrel. */
export const kHosting: unique symbol = Symbol('@caffeinejs/http:hosting')

/** A server the application runs: the engine behind it, and its lifecycle. */
export interface HostedServer extends IServer {
  /** Starts listening, on a server that listens; resolves at once on one that does not. */
  run(): Promise<void>
  teardown(): Promise<void>
  /** Abandons what is in flight, once the shutdown budget is spent. */
  forceTeardown(): Promise<void>
  /** What `app.listeners` hands out for it: what it is and where it listens, but not its lifecycle. */
  view(): IServer
}

/** How an application hosts one server: the settings its engine runs with, and what serves the ready engine. */
export interface ServerHosting {
  readonly settings: ResolvedServerSettings
  /** Whether the platform runs a Node middleware: one is refused at start-up otherwise. */
  readonly nodeMiddleware: boolean
  serve(engine: HTTPServer, context: HTTPSetupContext): Promise<HostedServer>
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

/** One server of the fetch application: no socket of its own, answering what the runtime hands `fetch`. */
export class FetchServer implements HostedServer {
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

  view(): IServer {
    // A server of the fetch application never listens: it has no address to change.
    return {
      address: undefined,
      request: (request, options) => this.request(request, options),
      fetch: (request, ...runtime) => this.fetch(request, ...runtime),
    }
  }
}
