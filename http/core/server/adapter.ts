import { AsyncLocalStorage } from 'node:async_hooks'

import type { RunInfo } from '@caffeinejs/application'
import { Scopes, type Container } from '@caffeinejs/di'

import type {
  AdapterFactory,
  AdapterFactoryIn,
  AdapterIn,
  IAdapter,
  IAdapterServer,
  IAdapterTypes,
  ServerAddress,
} from '../../adapter.js'
import type { CookieSerializeOptions } from '../cookie/options.js'
import { assertAuthorizationConfigured } from '../security/authz/index.js'
import { assertAuthenticationConfigured, assertRouteSchemesResolve } from '../security/security.js'
import { Context } from './context.js'
import { configurationError, USE_FASTIFY } from './error.js'
import { fetchPlatform, type FetchContextPlatform } from './fetch.js'
import { requestInProcess } from './in_process.js'
import { HTTPServer } from './server.js'
import { resolveServerSettings, type ServerSettings } from './settings.js'

/**
 * The fetch application's adapter types. They are not in `AdapterRegistry`, so a plain `IContext` keeps Fastify's
 * types.
 */
export interface FetchAdapterTypes extends IAdapterTypes {
  instance: never
  request: Context
  extension: never
  hook: never
  raw: Request
  cookieOptions: CookieSerializeOptions
  asyncCookies: true
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
  readonly #storage = new AsyncLocalStorage<Context>()

  constructor(kit: AdapterFactoryIn) {
    this.#container = kit.container
    this.#container.bind(Context, t =>
      t
        .toFactory(() => this.#storage.getStore()!)
        .lifetime(Scopes.REQUEST)
        .byPassPostProcessors()
        .internal(),
    )
  }

  async setup(input: AdapterIn<FetchAdapterTypes>): Promise<IAdapterServer<FetchAdapterTypes>> {
    if (input.customize !== undefined) {
      throw configurationError(
        'Cannot run ".serverCallback(...)" on the fetch application: it has no server instance',
        USE_FASTIFY,
      )
    }

    const scopes = input.routeGroups.flatMap(group => group.scopes ?? [])

    if (input.extensions.root().length > 0 || scopes.some(scope => input.extensions.of(scope.key).length > 0)) {
      throw configurationError(
        'Cannot install a server plugin on the fetch application: only an HTTPPlugin is supported yet',
        USE_FASTIFY,
      )
    }

    if (
      input.middlewares.resolve(input.context).length > 0 ||
      scopes.some(scope => input.extensions.middlewaresOf(scope.key).length > 0)
    ) {
      throw configurationError(
        'Cannot install middleware on the fetch application: it runs no middleware yet',
        USE_FASTIFY,
      )
    }

    const settings = resolveServerSettings(input.server)

    assertAuthenticationConfigured(this.#container, input.routeGroups)
    assertRouteSchemesResolve(this.#container, input.routeGroups)
    assertAuthorizationConfigured(this.#container, input.routeGroups)

    const server = new HTTPServer({
      routeGroups: input.routeGroups,
      settings,
      basePath: input.basePath,
      container: this.#container,
      storage: this.#storage,
      logger: input.context.logger,
    })

    input.recordRoutes(server.routes)

    return new FetchServer(server)
  }
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
