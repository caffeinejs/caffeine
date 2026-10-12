import { errMessage } from '@caffeinejs/std/framework/err'

import type {
  Adapter,
  AdapterExtensions,
  AdapterServer,
  AdapterTypes,
  HTTPSetupContext,
  ServerConfigurer,
  ServerCustomizer,
  SetupApplication,
} from './adapter.js'
import { normalizeBasePath } from './base_path.js'
import { boundTo } from './binding.js'
import { ErrCaffeineWebApplication, ErrConfiguration } from './error/common.js'
import { servedOn } from './routing/programmatic/bind.js'
import type { Router } from './routing/programmatic/router.js'
import type { RouteGroup } from './routing/route.js'
import type { DeclaredRouteGroup } from './routing/routing.js'
import type { ServerDefinition } from './server_definition.js'

type AnyRouter = Router<any, any, any, any, any, any>

/** One server: the definition it is built from, whether it has been routed, and what the adapter built. */
interface Entry<T extends AdapterTypes> {
  readonly definition: ServerDefinition<T>
  routed: boolean
  server?: AdapterServer<T>
}

/** What every server is built with that is not its own. */
export interface ServerSetupInput<T extends AdapterTypes> {
  /**
   * The application's own server's context, whose `app` mounts on that server. An ops server's is this one with a
   * child logger and an `app` of its own.
   */
  readonly context: HTTPSetupContext
  /** The framework's head slots, built fresh for one server: error handling, then cookies. */
  headSlots(): T['extension'][]
  /** What routers and controllers install in front of their groups: shared by every server, filled by each pass. */
  readonly scoped: AdapterExtensions<T['extension']>
  /**
   * The routing pass of the server named `name`, `undefined` for the application's own: declares what was mounted on
   * it, compiles the groups bound to it and checks them. An ops server's routers come already bound to it.
   */
  route(name: string | undefined, routers: readonly AnyRouter[]): Promise<RouteGroup<T['request']>[]>
}

/**
 * Every server an application runs, each built from its {@link ServerDefinition}, one after another: the
 * application's own first, so it is the first to listen and the first to close. A server is set up whole, its
 * settings, its factories and its build, before the next one's settings run, and its adapter routes it once its
 * plugins have loaded.
 */
export class ServerSet<T extends AdapterTypes> {
  readonly #entries: Entry<T>[]

  /** @param definitions - The application's own first, then the named ones in install order. */
  constructor(definitions: readonly ServerDefinition<T>[]) {
    this.#entries = definitions.map(definition => ({ definition, routed: false }))
  }

  /** The named servers, in install order. */
  get names(): string[] {
    return this.#named().map(entry => entry.definition.name!)
  }

  /** The first server, the application's own, once {@link setup} has built it. */
  get own(): AdapterServer<T> | undefined {
    return this.#entries[0]?.server
  }

  /** The named servers, once {@link setup} has built them. */
  get named(): ReadonlyMap<string, AdapterServer<T>> | undefined {
    if (this.#entries.some(entry => entry.server === undefined)) {
      return undefined
    }

    return new Map(this.#named().map(entry => [entry.definition.name!, entry.server!]))
  }

  /**
   * Mounts routers on the server named `name`, `undefined` for the application's own, for its routing pass to
   * declare.
   *
   * @throws ErrConfiguration once that server is routed.
   */
  mount(name: string | undefined, routers: readonly AnyRouter[]): void {
    const entry = this.#entries.find(candidate => candidate.definition.name === name)!

    if (entry.routed) {
      throw alreadyRouted(name)
    }

    entry.definition.routers.push(...routers)
  }

  /**
   * Builds every server through `adapter`, one after another: a server's settings, then its factories, then its
   * build, in which the adapter routes it.
   *
   * @throws ErrCaffeineWebApplication with code `ERR_HTTP_ADAPTER_ROUTING` for an adapter that never routed a server,
   *   or routed one twice.
   */
  async setup(adapter: Adapter<T>, input: ServerSetupInput<T>): Promise<void> {
    for (const entry of this.#entries) {
      await this.#build(entry, adapter, input)
    }
  }

  /**
   * Listens on every server, one after another. The first, the application's own, is handed `args`; every other
   * listens on the settings it was built with.
   */
  async run(args: T['runArgs']): Promise<void> {
    for (const [index, entry] of this.#entries.entries()) {
      await entry.server?.run(...((index === 0 ? args : []) as T['runArgs']))
    }
  }

  /** Closes every server built, the rest even when one fails. Resolves to what failed. */
  async teardown(): Promise<unknown[]> {
    const failures: unknown[] = []

    for (const entry of this.#entries) {
      try {
        await entry.server?.teardown()
      } catch (err) {
        failures.push(err)
      }
    }

    return failures
  }

  async forceTeardown(): Promise<void> {
    for (const entry of this.#entries) {
      await entry.server?.forceTeardown?.()
    }
  }

  async #build(entry: Entry<T>, adapter: Adapter<T>, input: ServerSetupInput<T>): Promise<void> {
    const { definition } = entry
    const context = this.#contextOf(definition.name, input.context)

    // The server's own settings first: they describe what everything below registers onto, and a callback that
    // fails should do so before a factory with side effects has run.
    const server = await resolveServerOptions(definition.server, context)
    const basePath = normalizeBasePath(await definition.basePath?.(context))
    const root = await rootExtensions(definition, context, input.headSlots())

    entry.server = await adapter.setup({
      route: () => this.#route(entry, input),
      context,
      middlewares: definition.middlewares,
      extensions: input.scoped.withRoot(root),
      server,
      customize: foldCustomizers(definition.customizers),
      basePath,
    })

    if (!entry.routed) {
      throw unrouted(definition.name)
    }
  }

  // Async, so whatever refuses the server reaches the adapter as a rejection.
  async #route(entry: Entry<T>, input: ServerSetupInput<T>): Promise<readonly RouteGroup<T['request']>[]> {
    const { name, routers } = entry.definition

    if (entry.routed) {
      throw routedTwice(name)
    }

    // Before anything else runs, so what the pass declares is all the server serves.
    entry.routed = true

    return input.route(name, name === undefined ? routers : servedOn(name, routers))
  }

  /**
   * The context the server named `name` is set up with: the application's for its own server, and for an ops server a
   * copy with a logger of its own and an `app` that mounts on it.
   */
  #contextOf(name: string | undefined, base: HTTPSetupContext): HTTPSetupContext {
    if (name === undefined) {
      return base
    }

    const app: SetupApplication = {
      mount: (...routers) => {
        this.mount(name, routers)
        return app
      },
    }

    return { ...base, logger: base.logger.child({ server: name }), app }
  }

  #named(): Entry<T>[] {
    return this.#entries.filter(entry => entry.definition.name !== undefined)
  }
}

/**
 * Refuses what the routing pass of the server named `name` declared and cannot serve. On the application's own
 * server, that is a router bound to a name no installed server has: nothing would serve it, and serving it on the
 * application's own server instead would expose what its binding kept off it. On an ops server, it is a router bound
 * to another server, since an ops server's factories mount on that server alone.
 *
 * @throws ErrConfiguration for the first such router.
 */
export function assertBindings<R>(
  declared: readonly DeclaredRouteGroup<R>[],
  name: string | undefined,
  installed: readonly string[],
): void {
  for (const group of declared) {
    const bound = boundTo(group.spec.labels)

    if (name !== undefined && bound !== name) {
      throw new ErrConfiguration(
        errMessage(`Cannot mount router "${group.name}" on ops server "${name}": it is bound to "${String(bound)}"`)
          .solutions(
            `Drop its "bindTo('${String(bound)}')": a router an ops server's factory mounts is served on that server`,
            'Or mount it from the application, with "app.mount(...)" or a ".with(...)" factory: it is then served ' +
              'where its binding says',
          )
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    if (name === undefined && bound !== undefined && !installed.includes(bound)) {
      const fixes = [`Install it: ".install(Ops('${bound}', ...))"`]

      if (installed.length > 0) {
        fixes.push(`Or bind to an installed server: ${installed.map(candidate => `"${candidate}"`).join(', ')}`)
      }

      throw new ErrConfiguration(
        errMessage(
          `Cannot serve router "${group.name}": it is bound to "${bound}", and no installed server has that name`,
        )
          .solutions(...fixes)
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }
  }
}

/** The framework's head slots, then the server's `.with(...)` factories' extensions, in the order they were written. */
async function rootExtensions<T extends AdapterTypes>(
  definition: ServerDefinition<T>,
  context: HTTPSetupContext,
  root: T['extension'][],
): Promise<T['extension'][]> {
  for (const [index, factory] of definition.plugins.entries()) {
    const extension = await factory(context)

    // What a factory that only mounted routers hands back: it installs nothing.
    if (extension === context.app) {
      continue
    }

    if (extension === undefined) {
      throw nothingReturned(index, definition.name)
    }

    root.push(extension as T['extension'])
  }

  return root
}

/**
 * Refuses a `.with(...)` factory that handed nothing back. Typed code cannot write one; untyped code would otherwise
 * lose a forgotten plugin without a word, since a factory that mounted routers may be one that also meant to install.
 */
function nothingReturned(index: number, name: string | undefined): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(
      `Cannot register the plugin of ".with(...)" #${index + 1} on ${describeServer(name)}: its factory returned nothing`,
    )
      .solutions(
        'Return what the factory installs on the server',
        'A factory that only mounts routers returns "context.app": "return context.app.mount(router)"',
      )
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

/** Refuses a mount on a server whose routing pass has run: nothing would ever serve the router. */
function alreadyRouted(name: string | undefined): ErrConfiguration {
  const solutions =
    name === undefined
      ? [
          'Mount it from a ".with(...)" factory, or from the plugin that factory returns',
          'Call "app.mount(...)" before "bootstrap()"',
        ]
      : [
          `Mount it from a factory "Ops('${name}', o => o.with(...))" registers, or from the plugin that factory returns`,
          `Or mount it from the application, bound with "bindTo('${name}')", before "bootstrap()"`,
        ]

  return new ErrConfiguration(
    errMessage(`Cannot mount a router on ${describeServer(name)}: its routing has already been built`)
      .solutions(...solutions)
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function unrouted(name: string | undefined): ErrCaffeineWebApplication {
  return new ErrCaffeineWebApplication(
    errMessage(`Cannot set up ${describeServer(name)}: its adapter never routed it`)
      .solutions(ADAPTER_ROUTING)
      .reference('@caffeinejs/http', ErrCaffeineWebApplication)
      .build(),
    'ERR_HTTP_ADAPTER_ROUTING',
  )
}

function routedTwice(name: string | undefined): ErrCaffeineWebApplication {
  return new ErrCaffeineWebApplication(
    errMessage(`Cannot route ${describeServer(name)} twice: its routes are already compiled`)
      .solutions(ADAPTER_ROUTING)
      .reference('@caffeinejs/http', ErrCaffeineWebApplication)
      .build(),
    'ERR_HTTP_ADAPTER_ROUTING',
  )
}

const ADAPTER_ROUTING =
  'Call "input.route()" once from the adapter\'s "setup(input)", after installing "input.extensions.root()" and ' +
  'before registering a route'

/** How a message names the server called `name`. */
function describeServer(name: string | undefined): string {
  return name === undefined ? "the application's own server" : `ops server "${name}"`
}

/**
 * Folds every `.server(configure)` result into one, section by section: a section that is an object is
 * shallow-merged over the one before it, anything else replaces. Sections are copied, never aliased — a live
 * configuration node is read-only, and the adapter writes into what it is handed.
 */
async function resolveServerOptions<T extends AdapterTypes>(
  configurers: readonly ServerConfigurer<T>[],
  context: HTTPSetupContext,
): Promise<T['serverOptions']> {
  const merged: Record<string, unknown> = {}

  for (const configure of configurers) {
    for (const [section, value] of Object.entries(await configure(context))) {
      if (value === undefined) {
        continue
      }

      const current = merged[section]
      merged[section] = isPlainObject(value) ? { ...(isPlainObject(current) ? current : {}), ...value } : value
    }
  }

  return merged as T['serverOptions']
}

/** Every `.serverCallback(...)` callback as one, run in call order; `undefined` when there is none. */
function foldCustomizers<T extends AdapterTypes>(
  customizers: readonly ServerCustomizer<T>[],
): ServerCustomizer<T> | undefined {
  if (customizers.length === 0) {
    return undefined
  }

  const all = [...customizers]

  return async (context, instance) => {
    for (const customize of all) {
      await customize(context, instance)
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
