import type { RunInfo } from '@caffeinejs/application'
import { contextKey, ContextStorage, Scopes, type Container, type ContextKey } from '@caffeinejs/di'

import type {
  AdapterFactory,
  AdapterFactoryIn,
  AdapterIn,
  IAdapter,
  IAdapterServer,
  IAdapterTypes,
  ServerAddress,
} from '../../adapter.js'
import { HookBatch } from '../lifecycle/batch.js'
import { rebaseMiddlewares } from '../middleware/path.js'
import type { IRouteGroup, RouteGroupScope } from '../routing/route.js'
import { assertAuthorizationConfigured } from '../security/authz/index.js'
import { assertAuthenticationConfigured, assertRouteSchemesResolve } from '../security/security.js'
import { Context, type EngineContextTypes } from './context.js'
import { configurationError, USE_FASTIFY } from './error.js'
import { fetchPlatform, type FetchContextPlatform } from './fetch.js'
import { requestInProcess } from './in_process.js'
import { HTTPServer } from './server.js'
import { resolveServerSettings, type ResolvedServerSettings, type ServerSettings } from './settings.js'

/**
 * The fetch application's adapter types. They are not in `AdapterRegistry`, so a plain `IContext` keeps Fastify's
 * types.
 */
export interface FetchAdapterTypes extends EngineContextTypes {
  instance: never
  request: Context
  platform: FetchContextPlatform
  serverOptions: ServerSettings
  runArgs: []
  runInfo: RunInfo
}

/** The adapter of the fetch application, which serves on the web-standards engine. */
export function fetchAdapterFactory(): AdapterFactory<FetchAdapterTypes> {
  return kit => new FetchAdapter(kit)
}

class FetchAdapter implements IAdapter<FetchAdapterTypes> {
  readonly #container: Container
  readonly #contextKey: ContextKey<Context>

  constructor(kit: AdapterFactoryIn) {
    this.#container = kit.container
    this.#contextKey = bindContext(kit.container)
  }

  async setup(input: AdapterIn<FetchAdapterTypes>): Promise<IAdapterServer<FetchAdapterTypes>> {
    if (input.customize !== undefined) {
      throw configurationError(
        'Cannot run ".serverCallback(...)" on the fetch application: it has no server instance',
        USE_FASTIFY,
      )
    }

    const engine = buildEngine(
      this.#container,
      this.#contextKey,
      input.routeGroups,
      input,
      resolveServerSettings(input.server),
      false,
    )
    await engine.ready()

    return new FetchServer(engine)
  }
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
 * Builds the engine for one server: refuses a server plugin that is not an `HTTPPlugin`, checks authentication and
 * authorization, registers the routes with their hooks and middleware, and records them.
 *
 * @param nodeMiddleware - Whether the platform runs Node middleware; a Node middleware is refused otherwise.
 * @throws ErrConfiguration for what the engine cannot serve yet.
 */
export function buildEngine<T extends IAdapterTypes>(
  container: Container,
  key: ContextKey<Context>,
  routeGroups: IRouteGroup<Context>[],
  input: AdapterIn<T>,
  settings: ResolvedServerSettings,
  nodeMiddleware: boolean,
): HTTPServer {
  const scopes = routeGroups.flatMap(group => group.scopes ?? [])
  const batchesOf = (entries: readonly unknown[]): HookBatch[] => {
    if (entries.some(entry => !(entry instanceof HookBatch))) {
      throw configurationError(
        `Cannot install a server plugin on the ${settings.application}: only an HTTPPlugin is supported yet`,
        USE_FASTIFY,
      )
    }

    return entries as HookBatch[]
  }

  // Every scope a served group lists, checked before any route registers.
  const root = { batches: batchesOf(input.extensions.root()), middlewares: input.middlewares.resolve(input.context) }
  for (const scope of scopes) {
    batchesOf(input.extensions.of(scope.key))
  }

  const levels = {
    root,
    of: (scope: RouteGroupScope) => ({
      batches: input.extensions.of(scope.key) as HookBatch[],
      middlewares: rebaseMiddlewares(scope.path, input.extensions.middlewaresOf(scope.key)),
    }),
  }

  assertAuthenticationConfigured(container, routeGroups)
  assertRouteSchemesResolve(container, routeGroups)
  assertAuthorizationConfigured(container, routeGroups)

  const server = new HTTPServer({
    routeGroups,
    settings,
    basePath: input.basePath,
    container,
    contextKey: key,
    logger: input.context.logger,
    levels,
    nodeMiddleware,
  })

  input.recordRoutes(server.routes)

  return server
}

/** One server the fetch adapter built: no socket of its own, answering what the runtime hands `fetch`. */
class FetchServer implements IAdapterServer<FetchAdapterTypes> {
  readonly #server: HTTPServer

  constructor(server: HTTPServer) {
    this.#server = server
  }

  readonly fetch = (request: Request, ...runtime: unknown[]): Response | Promise<Response> =>
    this.#server.serve(fetchPlatform, request, runtime)

  /** @throws ErrConfiguration: the fetch application has no server instance. */
  get instance(): never {
    throw configurationError(
      'Cannot read the server instance: the fetch application has none',
      'Hand app.fetch to the runtime, such as export default { fetch: app.fetch }',
    )
  }

  get address(): ServerAddress | undefined {
    return undefined
  }

  request(input: Request | string | URL, options?: RequestInit): Promise<Response> {
    return requestInProcess(this.#server, input, options)
  }

  run(): Promise<void> {
    return Promise.resolve()
  }

  teardown(): Promise<void> {
    return this.#server.close()
  }

  forceTeardown(): Promise<void> {
    this.#server.forceClose()
    return Promise.resolve()
  }
}
