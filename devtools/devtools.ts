import {
  FeatureBuilder,
  kFeatureConfigure,
  kFeatureName,
  type BootstrapKit,
  type Feature,
  type FeatureConfigureKit,
  type FeatureConfigurer,
} from '@caffeinejs/application'
import type { ConfigStore } from '@caffeinejs/application/config'
import { DevTool, ErrDevToolInvalid, ErrDevToolNotFound, type DevToolOperation } from '@caffeinejs/application/devtools'
import {
  ErrHTTPBadRequest,
  ErrHTTPMisdirectedRequest,
  ErrHTTPNotFound,
  ErrHTTPUnsupportedMediaType,
  HTTPPlugin,
  ListenerBuilder,
  Router,
  type AdapterExtensionFactory,
  type HTTPSetupContext,
  type IContext,
  type RouteAuthzOptions,
} from '@caffeinejs/http'
import { authentication, type HTTPPluginConfigurer, type RouterTypes } from '@caffeinejs/http/fastify'
import { errMessage } from '@caffeinejs/std/err'

import { ConfigTool } from './config/config.js'
import { DependencyInjectionTool } from './di/di.js'
import { ErrDevToolsConfiguration, ErrDevToolsInProduction } from './errors.js'
import { EventsTool } from './events/events.js'
import { HealthTool } from './health/health.js'
import { InfoTool } from './info/info.js'
import { RefreshablesTool } from './refreshables/refreshables.js'
import { RoutesTool } from './routes/routes.js'
import { RuntimeTool } from './runtime/runtime.js'

/** What the devtools' own server listens on, and where the devtools are served on it. */
export interface DevToolsConfig {
  /** Default `127.0.0.1`: the devtools answer nobody outside the machine unless told to. */
  host: string
  /** Default `9090`. */
  port: number
  /** Default `/devtools`. */
  path: string
}

/** What one devtools mount serves, resolved. */
interface DevToolsOptions {
  readonly path: string
  /** What every devtools route requires; `undefined` leaves them to the server's own gate and fallback policy. */
  readonly authorize: RouteAuthzOptions | undefined
  readonly showConfigValues: boolean
  readonly redact: readonly string[]
  readonly allowProduction: boolean
}

/** What `GET /devtools` answers: every tool, with a link to each of its resources. */
export interface DevToolsIndex {
  readonly tools: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description: string
    /** One per operation; a path parameter stays in the link as written: `/devtools/di/bindings/:id`. */
    readonly links: ReadonlyArray<{ readonly method: DevToolOperation['method']; readonly href: string }>
  }>
}

/** The name of the server `DevTools()` adds, and its listener in `app.listeners`, unless `listener(name)` names it. */
export const DEVTOOLS_LISTENER = 'devtools'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9090
const DEFAULT_PATH = '/devtools'

const kResolve: unique symbol = Symbol('@caffeinejs/devtools:resolve')

/**
 * What a devtools mount serves and who may reach it, for `devTools(d => ...)` and, through `DevTools(d => ...)`, for
 * the devtools' own server.
 */
export class DevToolsPluginBuilder {
  #path: string | undefined
  #authorize: RouteAuthzOptions | undefined
  #showConfigValues = false
  #redact: string[] = []
  #allowProduction = false

  /** Where the devtools are served, `/devtools` by default. Every tool is under it: `/devtools/routes`. */
  path(path: string): this {
    this.#path = path
    return this
  }

  /**
   * What every devtools route requires, as `router.authorize(...)` takes it: roles, policies, schemes.
   *
   * It takes `.install(Authentication(...))` on the application. `DevTools()` registers the authentication gate on
   * its own server whenever authentication is installed, so the application's fallback policy reaches the devtools
   * too; with `devTools()` the server's own gate authenticates.
   */
  authorize(options: RouteAuthzOptions = {}): this {
    this.#authorize = options
    return this
  }

  /**
   * Shows configuration values, where by default only their paths and origins are. A secret stays masked: a
   * `$t.Secret` field, a path whose segment names one (`password`, `token`, `apiKey`, ...), a path {@link redact}
   * names, and the password of a URL.
   */
  showConfigValues(): this {
    this.#showConfigValues = true
    return this
  }

  /**
   * Masks the configuration values under these dotted paths, besides what the schema and the key names mark. `*`
   * stands for one segment and `**` for any number: `redact('stripe.*', 'db.url')`.
   */
  redact(...paths: string[]): this {
    this.#redact.push(...paths)
    return this
  }

  /**
   * Starts the devtools where `NODE_ENV` is `production`, which is refused otherwise. Protect them with
   * {@link authorize}, or serve them where nothing outside your network reaches.
   */
  allowProduction(): this {
    this.#allowProduction = true
    return this
  }

  /** @internal */
  [kResolve](fallbackPath: string | undefined): DevToolsOptions {
    return {
      path: assertPath(this.#path ?? fallbackPath ?? DEFAULT_PATH),
      authorize: this.#authorize,
      showConfigValues: this.#showConfigValues,
      redact: [...this.#redact],
      allowProduction: this.#allowProduction,
    }
  }
}

/**
 * The devtools on a server of their own: `DevTools()` adds a listener named {@link DEVTOOLS_LISTENER} unless
 * `listener(name)` names it, on `127.0.0.1:9090` unless told otherwise, and serves the devtools there alone.
 */
export class DevToolsBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'devtools'

  readonly #options = new DevToolsPluginBuilder()
  #config: Partial<DevToolsConfig> | undefined
  #listener: string | undefined
  #host: string | undefined
  #port: number | undefined
  #resolved: DevToolsOptions | undefined
  #address: { host: string; port: number } | undefined

  /** Takes what the configuration holds: `d.config(config.app.devtools)`. A fluent setter wins over it. */
  config(config: Partial<DevToolsConfig>): this {
    this.#config = config
    return this
  }

  /**
   * The name of the devtools' server, `devtools` by default: its key in `app.listeners`. Name it otherwise when the
   * application already has a listener named `devtools`.
   */
  listener(name: string): this {
    this.#listener = name
    return this
  }

  /** The address the devtools' server listens on, `127.0.0.1` by default. */
  host(host: string): this {
    this.#host = host
    return this
  }

  /** The port the devtools' server listens on, `9090` by default; `0` for one the system picks. */
  port(port: number): this {
    this.#port = port
    return this
  }

  /** See {@link DevToolsPluginBuilder.path}. */
  path(path: string): this {
    this.#options.path(path)
    return this
  }

  /** See {@link DevToolsPluginBuilder.authorize}. */
  authorize(options: RouteAuthzOptions = {}): this {
    this.#options.authorize(options)
    return this
  }

  /** See {@link DevToolsPluginBuilder.showConfigValues}. */
  showConfigValues(): this {
    this.#options.showConfigValues()
    return this
  }

  /** See {@link DevToolsPluginBuilder.redact}. */
  redact(...paths: string[]): this {
    this.#options.redact(...paths)
    return this
  }

  /** See {@link DevToolsPluginBuilder.allowProduction}. */
  allowProduction(): this {
    this.#options.allowProduction()
    return this
  }

  protected override async configure(kit: FeatureConfigureKit<C>): Promise<void> {
    const options = this.#options[kResolve](this.#config?.path)
    assertNotProduction(options, 'Serve devtools on a host and port only your network reaches, with "host(...)"')

    const address = {
      host: assertHost(this.#host ?? this.#config?.host ?? DEFAULT_HOST),
      port: assertPort(this.#port ?? this.#config?.port ?? DEFAULT_PORT),
    }
    this.#resolved = options
    this.#address = address

    // Attached before the container initializes, so its start-up is recorded.
    const events = new EventsTool(kit.container.hooks)

    const listener = new ListenerBuilder<C>(this.#listener ?? DEVTOOLS_LISTENER, l => {
      l.server(() => ({ listener: { ...address } }))

      // A listener has no gate unless one is registered on it, and a route the fallback policy or `authorize(...)`
      // protects with no gate over it is refused at start-up. So the gate goes wherever authentication is installed,
      // and `authorize(...)` without it fails as the gate does, naming the feature.
      l.with(context =>
        options.authorize !== undefined || context.hasFeature('auth')
          ? // Named, and without the OIDC routes: they belong to the application's own gate, the first to install.
            authentication(g => g.name('devtools').oidcRoutes(false))(context)
          : new NoGate(),
      )

      l.with(devToolsPlugin(options, events))
    })

    await listener[kFeatureConfigure](kit)
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    const { host, port } = this.#address!

    if (this.#resolved!.authorize === undefined && !isLoopback(host)) {
      kit.logger.warn(
        { host, port },
        'Devtools answer anyone who reaches this address: protect them with "authorize(...)" or listen on 127.0.0.1',
      )
    }
  }
}

/**
 * Serves the devtools on a server of their own, listening on `127.0.0.1:9090` unless told otherwise:
 *
 * ```ts
 * createWebApplication().install(DevTools())
 * createWebApplication().install(DevTools((d, { config }) => d.config(config.app.devtools).authorize({ roles: ['ops'] })))
 * ```
 *
 * Every tool is a set of REST resources under `/devtools/<id>`, and `GET /devtools` lists them: the bindings and the
 * dependency graph, the configuration, the routes and what protects them, health, refreshables, container events,
 * runtime and info, and every tool a package or the application contributed by binding a {@link DevTool}.
 *
 * @throws ErrDevToolsInProduction at start-up where `NODE_ENV` is `production` and `allowProduction()` was not called.
 * @throws ErrDevToolsConfiguration at start-up for a malformed path, host or port, or a malformed tool.
 * @throws ErrFeatureNotInstalled at start-up when `authorize(...)` is set and `Authentication(...)` is not installed.
 */
export function DevTools<C = unknown>(configure?: FeatureConfigurer<DevToolsBuilder<C>, C>): Feature<C> {
  return new DevToolsBuilder<C>(configure as FeatureConfigurer<never, C> | undefined)
}

/**
 * Serves the devtools on a server that already exists: the application's own with `.with(devTools())`, a listener's
 * with `l.with(devTools())`. The server's own gate and fallback policy apply to them as to every route there, and
 * `authorize(...)` adds what they require.
 *
 * Prefer `.install(DevTools())`, which keeps them off the port the application serves its users on.
 *
 * @throws ErrDevToolsInProduction at start-up where `NODE_ENV` is `production` and `allowProduction()` was not called.
 * @throws ErrDevToolsConfiguration at start-up for a malformed path or a malformed tool.
 */
export function devTools<C = unknown>(
  configure?: HTTPPluginConfigurer<DevToolsPluginBuilder, C>,
): AdapterExtensionFactory<HTTPPlugin, C> {
  return context => {
    const builder = new DevToolsPluginBuilder()
    configure?.(builder, context as HTTPSetupContext<C, RouterTypes>)

    const options = builder[kResolve](undefined)
    assertNotProduction(options, 'Serve devtools on a server of their own instead: ".install(DevTools())"')

    return devToolsPlugin(options)(context)
  }
}

function devToolsPlugin<C>(options: DevToolsOptions, events?: EventsTool): AdapterExtensionFactory<HTTPPlugin, C> {
  return context => {
    if (options.allowProduction && isProduction()) {
      context.logger.warn({ path: options.path }, 'Devtools are running in production')
    }

    return new DevToolsPlugin(options, events)
  }
}

/** What stands in for the gate on the devtools' own server when the application authenticates nobody. */
class NoGate extends HTTPPlugin {
  register(): void {
    // Nothing to authenticate with: a route nothing protects needs no gate.
  }
}

class DevToolsPlugin extends HTTPPlugin {
  readonly #options: DevToolsOptions
  readonly #events: EventsTool | undefined

  constructor(options: DevToolsOptions, events: EventsTool | undefined) {
    super()
    this.#options = options
    this.#events = events
  }

  register(context: HTTPSetupContext): void {
    const { container } = context
    const store = context.store as ConfigStore<unknown>
    const options = this.#options
    const tools: DevTool[] = [
      new InfoTool(container, store),
      new HealthTool(container),
      new DependencyInjectionTool(container),
      new ConfigTool(store, { showValues: options.showConfigValues, redact: options.redact }),
      new RoutesTool(container),
      new RefreshablesTool(container),
      this.#events ?? new EventsTool(container.hooks),
      new RuntimeTool(),
      ...container.getManyOptional(DevTool),
    ]

    assertTools(tools)

    const router = new Router(options.path).detail('http', { internal: true }).header('cache-control', 'no-store')

    if (options.authorize !== undefined) {
      router.authorize(options.authorize)
    }

    router.get('/', (ctx: IContext): DevToolsIndex => {
      assertLoopbackHost(ctx)
      return { tools: tools.map(tool => indexOf(tool, options.path)) }
    })

    for (const tool of tools) {
      for (const operation of tool.operations) {
        router.route(operation.method, `/${tool.id}${operation.path}`, (ctx: IContext) => answer(operation, ctx))
      }
    }

    context.app.mount(router)
  }
}

function indexOf(tool: DevTool, path: string): DevToolsIndex['tools'][number] {
  return {
    id: tool.id,
    title: tool.title,
    description: tool.description,
    links: tool.operations.map(operation => ({
      method: operation.method,
      href: `${path}/${tool.id}${operation.path}`,
    })),
  }
}

/**
 * Whether a `Content-Type` is JSON, `application/json` or `application/<anything>+json`: a body a cross-site form
 * cannot send without a preflight, which is what keeps a changing request same-origin.
 */
function isJSON(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase()

  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}

async function answer(operation: DevToolOperation, ctx: IContext): Promise<unknown> {
  assertLoopbackHost(ctx)

  const withBody = operation.method === 'POST' || operation.method === 'PUT' || operation.method === 'PATCH'

  if (withBody && !isJSON(ctx.req.header('content-type'))) {
    throw new ErrHTTPUnsupportedMediaType('Cannot read the request body: it is not "application/json"')
  }

  let result: unknown
  try {
    result = await operation.handle({
      params: ctx.req.param() as Record<string, string>,
      query: queryOf(ctx.req.query() as Record<string, string | string[] | undefined>),
      body: withBody ? ctx.req.body() : undefined,
      // Read only by an operation that asks: reading it builds an abort controller for the request.
      get signal() {
        return ctx.signal
      },
    })
  } catch (err) {
    if (err instanceof ErrDevToolNotFound) {
      throw new ErrHTTPNotFound(err.message)
    }

    if (err instanceof ErrDevToolInvalid) {
      throw new ErrHTTPBadRequest(err.message)
    }

    throw err
  }

  ctx.status(operation.status ?? (result === undefined ? 204 : 200))
  return result
}

function queryOf(query: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
}

const TOOL_ID = /^[a-z][a-z0-9-]*$/
const OPERATION_PATH = /^(\/(:[A-Za-z_]\w*|[A-Za-z0-9._~-]+))*$/
const SERVED_PATH = /^(\/[A-Za-z0-9._~-]+)+$/

function assertTools(tools: readonly DevTool[]): void {
  const ids = new Set<string>()

  for (const tool of tools) {
    const name = tool.constructor.name

    if (!TOOL_ID.test(tool.id)) {
      throw configuration(
        `Cannot serve devtool "${name}": its id "${tool.id}" is not lower-case letters, digits and dashes`,
        'Give it an id such as "cache" or "job-queue"',
      )
    }

    if (ids.has(tool.id)) {
      throw configuration(
        `Cannot serve devtool "${name}": another tool already has the id "${tool.id}"`,
        'Give one of the two tools another id',
      )
    }
    ids.add(tool.id)

    const operations = new Set<string>()

    for (const operation of tool.operations) {
      if (!OPERATION_PATH.test(operation.path)) {
        throw configuration(
          `Cannot serve devtool "${tool.id}": the path "${operation.path}" of its ${operation.method} operation is malformed`,
          'Start the path with "/" and name a parameter with ":", such as "/entries/:key", or write "" for the root',
        )
      }

      const route = `${operation.method} ${operation.path.replace(/:\w+/g, ':')}`

      if (operations.has(route)) {
        throw configuration(
          `Cannot serve devtool "${tool.id}": two operations answer ${operation.method} "${operation.path}"`,
          'Remove one of the two operations',
        )
      }
      operations.add(route)
    }
  }
}

function assertNotProduction(options: DevToolsOptions, solution: string): void {
  if (!options.allowProduction && isProduction()) {
    throw new ErrDevToolsInProduction(solution)
  }
}

function assertPath(path: string): string {
  if (!SERVED_PATH.test(path)) {
    throw configuration(
      `Cannot serve devtools at "${path}": the path must be one or more "/segment"s`,
      'Write it as "/devtools" or "/_admin/devtools", without a trailing slash',
    )
  }

  return path
}

function assertHost(host: string): string {
  if (host.trim() === '') {
    throw configuration('Cannot listen for devtools: the host is empty', 'Write it as "127.0.0.1"')
  }

  return host
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw configuration(
      `Cannot listen for devtools on port "${port}": a port is a whole number from 0 to 65535`,
      'Write it as 9090, or 0 for a port the system picks',
    )
  }

  return port
}

function configuration(message: string, ...solutions: string[]): ErrDevToolsConfiguration {
  return new ErrDevToolsConfiguration(
    errMessage(message)
      .solutions(...solutions)
      .reference('@caffeinejs/devtools', ErrDevToolsConfiguration)
      .build(),
  )
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('::ffff:127.')
}

/**
 * Refuses a request that reached a loopback address under a `Host` naming anything else.
 *
 * A page on another site can resolve its own name to `127.0.0.1` (DNS rebinding) and become same-origin with a
 * server listening there, which takes it past every check a browser makes. Its requests still carry its own name as
 * the `Host`, so a server only this machine should reach answers loopback names alone. A request that came in on
 * another address, or with no socket at all (`app.request(...)`), is left alone.
 *
 * @throws ErrHTTPMisdirectedRequest for a loopback request whose `Host` is not `localhost`, `*.localhost`,
 * `127.x.x.x` or `[::1]`.
 */
export function assertLoopbackHost(ctx: IContext): void {
  const local = (ctx.req.raw as { socket?: { localAddress?: string } } | undefined)?.socket?.localAddress

  if (local === undefined || !isLoopback(local)) {
    return
  }

  const host = ctx.req.header('host') ?? ''
  let name: string
  try {
    name = new URL(`http://${host}`).hostname
  } catch {
    name = ''
  }

  if (name !== '[::1]' && name !== 'localhost' && !name.endsWith('.localhost') && !/^127\.\d+\.\d+\.\d+$/.test(name)) {
    throw new ErrHTTPMisdirectedRequest(`Cannot answer for host "${host}": this server answers loopback names alone`)
  }
}
