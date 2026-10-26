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
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import type { Container } from '@caffeinejs/di'
import {
  ErrHTTPMisdirectedRequest,
  ErrHTTPUnsupportedMediaType,
  HTTPPlugin,
  ListenerBuilder,
  RouteInventory,
  Router,
  type AdapterExtensionFactory,
  type HTTPSetupContext,
  type IContext,
  type RouteAuthzOptions,
} from '@caffeinejs/http'
import { authentication, type HTTPPluginConfigurer, type RouterTypes } from '@caffeinejs/http/fastify'
import { errMessage } from '@caffeinejs/std/err'

import { configRouter, ConfigTool, configTool } from './config/config.js'
import { diRouter, diTool } from './di/di.js'
import { ErrDevToolsConfiguration, ErrDevToolsInProduction } from './errors.js'
import { eventsRouter, EventsTool, eventsTool } from './events/events.js'
import { healthRouter, healthTool } from './health/health.js'
import { infoRouter, infoTool } from './info/info.js'
import { refreshablesRouter, RefreshablesTool, refreshablesTool } from './refreshables/refreshables.js'
import { routesRouter, routesTool } from './routes/routes.js'
import { runtimeRouter, RuntimeTool, runtimeTool } from './runtime/runtime.js'
import type { ToolInfo } from './tool.js'

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
export const DevToolsIndexSchema = $t.Object({
  tools: $t.Array(
    $t.Object({
      id: $t.String(),
      title: $t.String(),
      description: $t.String(),
      /** One per resource and method; a path parameter stays in the link as written: `/devtools/di/bindings/:id`. */
      links: $t.Array($t.Object({ method: $t.String(), href: $t.String() })),
    }),
  ),
})

export type DevToolsIndex = InferSchema<typeof DevToolsIndexSchema>

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
  readonly #redact: string[] = []
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
 * runtime and info.
 *
 * @throws ErrDevToolsInProduction at start-up where `NODE_ENV` is `production` and `allowProduction()` was not called.
 * @throws ErrDevToolsConfiguration at start-up for a malformed path, host or port.
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
 * @throws ErrDevToolsConfiguration at start-up for a malformed path.
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
    const options = this.#options
    const router = new Router(options.path).detail('http', { internal: true }).with(() => new DevToolsGuard())

    if (options.authorize !== undefined) {
      router.authorize(options.authorize)
    }

    router.mount(
      indexRouter(context.container, options.path, TOOLS),
      ...builtInRouters(context.container, context.store as ConfigStore<unknown>, options, this.#events),
    )

    context.app.mount(router)
  }
}

const TOOLS: readonly ToolInfo[] = [
  infoTool,
  healthTool,
  diTool,
  configTool,
  routesTool,
  refreshablesTool,
  eventsTool,
  runtimeTool,
]

function builtInRouters(
  container: Container,
  store: ConfigStore<unknown>,
  options: DevToolsOptions,
  events: EventsTool | undefined,
) {
  return [
    infoRouter(container, store),
    healthRouter(container),
    diRouter(container),
    configRouter(new ConfigTool(store, { showValues: options.showConfigValues, redact: options.redact })),
    routesRouter(container),
    refreshablesRouter(new RefreshablesTool(container)),
    eventsRouter(events ?? new EventsTool(container.hooks)),
    runtimeRouter(new RuntimeTool()),
  ] as const
}

/** `GET /devtools`: every tool, linked to each route it serves, as the application registered them. */
function indexRouter(container: Container, path: string, tools: readonly ToolInfo[]) {
  return new Router('')
    .get('')
    .schema({ response: { 200: DevToolsIndexSchema } })
    .handler((): DevToolsIndex => {
      const routes = container.get(RouteInventory).servers.flatMap(server => server.routes)

      return {
        tools: tools.map(tool => {
          const root = `${path}/${tool.id}`
          const links = new Map<string, { method: string; href: string }>()

          for (const route of routes) {
            if (route.url === root || route.url.startsWith(`${root}/`)) {
              const method = route.methods[0]!
              links.set(`${method} ${route.url}`, { method, href: route.url })
            }
          }

          return { id: tool.id, title: tool.title, description: tool.description, links: [...links.values()] }
        }),
      }
    })
}

/**
 * Every route of the built-in tools, relative to the devtools path: what `brewer` reads to type a client for them.
 *
 * ```ts
 * const devtools = brewer<DevToolsRoutes>('http://127.0.0.1:9090/devtools')
 * const res = await devtools.config.properties.get()
 * ```
 */
export type DevToolsRoutes = ReturnType<typeof indexRouter> | ReturnType<typeof builtInRouters>[number]

/**
 * What every devtools route asks of a request before it runs: a loopback name on a loopback address, and JSON for a
 * request that changes something, which a cross-site form cannot send without a preflight. Every answer from here on,
 * its own refusals included, is kept out of caches; the authentication gate, which runs first, answers on its own.
 */
class DevToolsGuard extends HTTPPlugin {
  register(context: HTTPSetupContext): void {
    context.app.use((ctx, next) => {
      ctx.header('cache-control', 'no-store')
      assertLoopbackHost(ctx)

      if (CHANGING.has(ctx.req.method) && !isJSON(ctx.req.header('content-type'))) {
        throw new ErrHTTPUnsupportedMediaType('Cannot read the request body: it is not "application/json"')
      }

      return next()
    })
  }
}

const CHANGING = new Set(['POST', 'PUT', 'PATCH'])

/**
 * Whether a `Content-Type` is JSON, `application/json` or `application/<anything>+json`: a body a cross-site form
 * cannot send without a preflight, which is what keeps a changing request same-origin.
 */
function isJSON(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase()

  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}

const SERVED_PATH = /^(\/[A-Za-z0-9._~-]+)+$/

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
