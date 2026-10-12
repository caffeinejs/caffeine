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
import { ErrConfiguration } from './error/common.js'
import { servedOn } from './routing/programmatic/bind.js'
import type { RouteGroup } from './routing/route.js'
import type { DeclaredRouteGroup, Routing } from './routing/routing.js'
import type { ServerDefinition } from './server_definition.js'

/** One server: the definition it is built from, the routers selected for it, and what the adapter built. */
interface Entry<T extends AdapterTypes> {
  readonly definition: ServerDefinition<T>
  groups: RouteGroup<T['request']>[]
  server?: AdapterServer<T>
}

/** What every server is built with that is not its own. */
export interface ServerSetupInput<T extends AdapterTypes> {
  /**
   * The application's, whose `app` mounts on the application itself: a named server's own is this one with a child
   * logger and an `app` of its own.
   */
  readonly context: HTTPSetupContext
  /** The framework's head slots, built fresh for one server: error handling, then cookies. */
  headSlots(): T['extension'][]
  /**
   * Builds routing, once every server's factories have run and before any server is built. Hands back what routers
   * and controllers asked to install in front of their groups on any server.
   */
  route(): Promise<AdapterExtensions<T['extension']>>
}

/** One server ready to build: the context it is set up with, its settings, and what its factories produced. */
interface Prepared<T extends AdapterTypes> {
  readonly entry: Entry<T>
  readonly context: HTTPSetupContext
  readonly server: T['serverOptions']
  readonly basePath: string | undefined
  readonly root: T['extension'][]
}

/**
 * Every server an application runs, each built from its {@link ServerDefinition}, in order: the application's own
 * first, so it is the first to listen and the first to close. Every server's settings and factories run before any
 * server is built, since a factory may mount routers and routing is built once all of them have.
 */
export class ServerSet<T extends AdapterTypes> {
  readonly #entries: Entry<T>[]

  /** @param definitions - The application's own first, then the named ones in install order. */
  constructor(definitions: readonly ServerDefinition<T>[]) {
    this.#entries = definitions.map(definition => ({ definition, groups: [] }))
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
   * Refuses a declared router bound to no server, then compiles the routers bound to each server. Returns every group
   * compiled, for the application's route table.
   *
   * @throws ErrConfiguration for a router bound to a name no server has.
   */
  select(
    routing: Routing<T['request']>,
    declared: readonly DeclaredRouteGroup<T['request']>[],
  ): RouteGroup<T['request']>[] {
    assertEveryRouterServed(declared, this.names)

    const compiled: RouteGroup<T['request']>[] = []

    for (const entry of this.#entries) {
      const name = entry.definition.name
      entry.groups = routing.select(labels => boundTo(labels) === name)
      compiled.push(...entry.groups)
    }

    return compiled
  }

  /**
   * Builds every server through `adapter`. Every server's settings and factories run first, in order; then
   * `input.route()` builds routing; then each server is built, one after another, from its own definition.
   */
  async setup(adapter: Adapter<T>, input: ServerSetupInput<T>): Promise<void> {
    const prepared: Prepared<T>[] = []

    for (const entry of this.#entries) {
      prepared.push(await prepare(entry, input))
    }

    const scoped = await input.route()

    for (const { entry, context, server, basePath, root } of prepared) {
      const { definition } = entry

      entry.server = await adapter.setup({
        routeGroups: entry.groups,
        context,
        middlewares: definition.middlewares,
        extensions: scoped.withRoot(root),
        server,
        customize: foldCustomizers(definition.customizers),
        basePath,
      })
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

  #named(): Entry<T>[] {
    return this.#entries.filter(entry => entry.definition.name !== undefined)
  }
}

/** Resolves one server's settings and runs its `.with(...)` factories, against the context the server is set up with. */
async function prepare<T extends AdapterTypes>(entry: Entry<T>, input: ServerSetupInput<T>): Promise<Prepared<T>> {
  const { definition } = entry
  const context = contextOf(definition.name, input.context)

  // The server's own settings first: they describe what everything below registers onto, and a callback that
  // fails should do so before a factory with side effects has run.
  const server = await resolveServerOptions(definition.server, context)
  const basePath = normalizeBasePath(await definition.basePath?.(context))

  // The framework's head slots, then its own `.with(...)` factories, in the order they were written.
  const root = input.headSlots()
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

  return { entry, context, server, basePath, root }
}

/**
 * The context the server named `name` is set up with: the application's for its own server, and for an ops server a
 * copy with a logger of its own and an `app` that serves on it what names no server.
 */
function contextOf(name: string | undefined, base: HTTPSetupContext): HTTPSetupContext {
  if (name === undefined) {
    return base
  }

  const app: SetupApplication = {
    mount: (...routers) => {
      base.app.mount(...servedOn(name, routers))
      return app
    },
  }

  return { ...base, logger: base.logger.child({ server: name }), app }
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

/**
 * Refuses a router bound to a name no installed server has. Nothing would serve it, and serving it on the
 * application's own server instead would expose what its binding kept off that server.
 */
function assertEveryRouterServed<R>(declared: readonly DeclaredRouteGroup<R>[], installed: readonly string[]): void {
  const unserved = declared.find(group => {
    const bound = boundTo(group.spec.labels)
    return bound !== undefined && !installed.includes(bound)
  })

  if (unserved === undefined) {
    return
  }

  const name = String(boundTo(unserved.spec.labels))
  const fixes = [`Install it: ".install(Ops('${name}', ...))"`]

  if (installed.length > 0) {
    const names = installed.map(candidate => `"${candidate}"`).join(', ')
    fixes.push(`Or bind to an installed server: ${names}`)
  }

  throw new ErrConfiguration(
    errMessage(
      `Cannot serve router "${unserved.name}": it is bound to "${name}", and no installed server has that name`,
    )
      .solutions(...fixes)
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
