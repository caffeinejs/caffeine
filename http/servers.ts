import type { ContextKey } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { normalizeBasePath } from './base_path.js'
import { boundTo, kBindTo } from './binding.js'
import { ErrConfiguration } from './core/error/common.js'
import type { HookBatch } from './core/lifecycle/batch.js'
import type { RouteGroupCompiler, RouteGroupMeta } from './core/routing/compile.js'
import { kCompleteInventory, kRecordServer, type RouteInventory } from './core/routing/inventory.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import type { ScopedPlugins } from './core/routing/programmatic/scoped_plugins.js'
import { FluentRouteSource } from './core/routing/programmatic/source.js'
import type { IRouteGroup, RouteGroupScope } from './core/routing/route.js'
import type { Routing } from './core/routing/routing.js'
import type { RouteGroupSpec } from './core/routing/spec.js'
import type { Context } from './core/server/context.js'
import {
  buildEngine,
  findMyWayFlags,
  type AnyServerAdapter,
  type HostedServer,
  type kHosting,
} from './core/server/hosting.js'
import type { HTTPServer } from './core/server/server.js'
import type { HTTPPluginFactory, HTTPSetupContext } from './plugin.js'
import { PluginSlot } from './plugin_slot.js'
import type { ServerConfigurer } from './server.js'
import type { ServerDefinition } from './server_definition.js'

/** One server: the definition it is built from, the routers selected for it, and what was built. */
interface Entry {
  readonly definition: ServerDefinition
  groups: IRouteGroup<Context>[]
  server?: HostedServer
  engine?: HTTPServer
}

/** What every server is built with that is not its own. */
export interface ServerSetupInput {
  /**
   * The application's, with a closed `app`: each server's own is this one with an `app` of its own and, for a named
   * server, a child logger.
   */
  readonly context: HTTPSetupContext
  /**
   * What routers and controllers asked for, resolved and installed in front of their groups on any server. What a
   * server's plugins mount is resolved into it too.
   */
  readonly plugins: ScopedPlugins
  /** The compiler every group went through, for a group `$route` adds. */
  readonly compileRouteGroup: RouteGroupCompiler
  /** Where each server's routes are recorded, complete once every server is built. */
  readonly inventory: RouteInventory
  /** The slot every engine sets in each request's frame. */
  readonly contextKey: ContextKey<Context>
  /** How the application's adapter hosts a server, built from `settings`. */
  readonly hosting: AnyServerAdapter[typeof kHosting]
  /** Runs what `.serverCallback(...)` registered on the application's own server, in call order. */
  readonly customize: (context: HTTPSetupContext, instance: unknown) => Promise<void>
}

/**
 * Every server an application runs, built one after another from its {@link ServerDefinition}, in order: the
 * application's own first, so it is the first to listen and the first to close.
 */
export class ServerSet {
  readonly #entries: Entry[]

  /** @param definitions - The application's own first, then the named ones in install order. */
  constructor(definitions: readonly ServerDefinition[]) {
    this.#entries = definitions.map(definition => ({ definition, groups: [] }))
  }

  /** The named servers, in install order. */
  get names(): string[] {
    return this.#named().map(entry => entry.definition.name!)
  }

  /** The first server, the application's own, once {@link setup} has built it. */
  get own(): HostedServer | undefined {
    return this.#entries[0]?.server
  }

  /** The named servers, once {@link setup} has built them. */
  get named(): ReadonlyMap<string, HostedServer> | undefined {
    if (this.#entries.some(entry => entry.server === undefined)) {
      return undefined
    }

    return new Map(this.#named().map(entry => [entry.definition.name!, entry.server!]))
  }

  /**
   * Compiles the routers bound to each server, and refuses one bound to no server. Returns every group compiled,
   * for the application's route table.
   *
   * @throws ErrConfiguration for a router bound to a name no server has.
   */
  select(routing: Routing<Context>): IRouteGroup<Context>[] {
    const compiled: IRouteGroup<Context>[] = []

    for (const entry of this.#entries) {
      const name = entry.definition.name
      entry.groups = routing.select(labels => boundTo(labels) === name)
      compiled.push(...entry.groups)
    }

    assertEveryRouterServed(routing, this.names)

    return compiled
  }

  /** Builds every server, one after another, each from its own definition. */
  async setup(input: ServerSetupInput): Promise<void> {
    for (const entry of this.#entries) {
      entry.server = await this.#build(entry, input)
    }

    input.inventory[kCompleteInventory]()
  }

  async #build(entry: Entry, input: ServerSetupInput): Promise<HostedServer> {
    const { definition } = entry
    const compile = serverCompiler(input.compileRouteGroup, definition.name)
    // What this server's plugins may do to the application: mount on it and add to its pipeline, while they register.
    const slot = new PluginSlot(definition.middlewares)
    const context = serverContext(input.context, definition.name, slot)

    // The server's own settings first: they describe what everything below registers onto, and a callback that
    // fails should do so before a factory with side effects has run.
    const settings = await resolveServerOptions(definition.server, context)
    const basePath = normalizeBasePath(await definition.basePath?.(context))
    const hosting = input.hosting(settings)
    slot.forServer(basePath ?? '', findMyWayFlags(hosting.settings))

    // Its own `.with(...)` factories, in the order they were written. The engine installs the framework's head
    // slots ahead of them.
    const where = definition.name === undefined ? "on the application's own server" : `on listener "${definition.name}"`
    const root = await slot.during(() => registerPlugins(definition.plugins, context, slot, where))

    // What the plugins mounted: those routers' own plugins first, since they may nest more, then the groups. A group
    // the application already serves on this server is served once, as a router mounted twice in one place is.
    await input.plugins.resolveRouters(slot.mounted, context)
    entry.groups.push(...compileMounted(slot.mounted, entry.groups, input.plugins, context, compile))

    const engine = buildEngine({
      contextKey: input.contextKey,
      routeGroups: entry.groups,
      context,
      middlewares: definition.middlewares,
      root,
      scoped: input.plugins,
      basePath,
      settings: hosting.settings,
      nodeMiddleware: hosting.nodeMiddleware,
      recordRoutes: routes =>
        input.inventory[kRecordServer]({ server: definition.name, basePath: basePath ?? '', routes }),
    })
    entry.engine = engine
    await engine.ready()

    // The application's own server alone runs the server callbacks: a listener is never handed over.
    const customize =
      definition.name === undefined
        ? (instance: unknown) => input.customize(context, instance)
        : () => Promise.resolve()

    return hosting.serve(engine, context, customize)
  }

  /**
   * Starts every server, one after another, the application's own first: it with what `run(options)` was given, each
   * listener on its own settings alone.
   */
  async run(options?: object): Promise<void> {
    for (const entry of this.#entries) {
      await entry.server?.run(entry.definition.name === undefined ? options : undefined)
    }
  }

  /**
   * Closes every server built, and the engine of a server whose build failed after its engine was built. Closes the
   * rest even when one fails. Resolves to what failed.
   */
  async teardown(): Promise<unknown[]> {
    const failures: unknown[] = []

    for (const entry of this.#entries) {
      try {
        await (entry.server?.teardown() ?? entry.engine?.close())
      } catch (err) {
        failures.push(err)
      }
    }

    return failures
  }

  async forceTeardown(): Promise<void> {
    for (const entry of this.#entries) {
      await entry.server?.forceTeardown()
    }
  }

  #named(): Entry[] {
    return this.#entries.filter(entry => entry.definition.name !== undefined)
  }
}

/**
 * Folds every `.server(configure)` result into one, section by section: a section that is an object is
 * shallow-merged over the one before it, anything else replaces it as given. An object section is copied, never
 * aliased — a live configuration node is read-only, and Node writes into what it is handed.
 */
async function resolveServerOptions(
  configurers: readonly ServerConfigurer<object>[],
  context: HTTPSetupContext,
): Promise<object> {
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

  return merged
}

/** A server's own context: the application's, with this server's `app` and, for a named server, a child logger. */
function serverContext(base: HTTPSetupContext, name: string | undefined, app: PluginSlot): HTTPSetupContext {
  return { ...base, logger: name === undefined ? base.logger : base.logger.child({ server: name }), app }
}

/**
 * Runs a server's `.with(...)` factories in the order written, each plugin registering in its slot. The hooks each
 * entry added keep its place in the list.
 */
async function registerPlugins(
  factories: readonly HTTPPluginFactory<any>[],
  context: HTTPSetupContext,
  slot: PluginSlot,
  where: string,
): Promise<HookBatch[]> {
  const root: HookBatch[] = []

  for (const factory of factories) {
    const batch = await slot.run(factory, context, where)

    if (!batch.empty) {
      root.push(batch)
    }
  }

  return root
}

/**
 * What a server's plugins mounted, compiled as the application's own routers are and bound to that server, less the
 * groups it already `served`.
 */
function compileMounted(
  routers: readonly AnyRouter[],
  served: readonly IRouteGroup<Context>[],
  plugins: ScopedPlugins,
  context: HTTPSetupContext,
  compile: RouteGroupCompiler,
): IRouteGroup<Context>[] {
  return new FluentRouteSource<Context>(routers, plugins.childrenOf)
    .collect(context.container)
    .filter(declared => !isServed(declared.scopes!, served))
    .map(declared => {
      const group = compile(declared.spec, declared.meta())
      // Always set: a programmatic group is installed under every router it is nested in.
      group.scopes = declared.scopes
      return group
    })
}

/** Whether `groups` already hold the group `scopes` describes: the same routers, nested the same way. */
function isServed(scopes: readonly RouteGroupScope[], groups: readonly IRouteGroup<Context>[]): boolean {
  // Per group, never per router: a router whose nested routers are bound elsewhere is split across servers, and a
  // plugin mounting it on one of them still adds the groups that server lacks.
  return groups.some(
    group => group.scopes?.length === scopes.length && group.scopes.every((scope, at) => scope.key === scopes[at].key),
  )
}

/**
 * What `$route` and a plugin's `app.mount(...)` compile a group with on the server named `name`: a group bound to
 * another server is refused, since that server would never see it, and an unbound one is bound to this one, as every
 * group it serves is.
 */
function serverCompiler(compile: RouteGroupCompiler, name: string | undefined): RouteGroupCompiler {
  return <R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>): IRouteGroup<R> => {
    const bound = boundTo(spec.labels)

    if (bound !== undefined && bound !== name) {
      const server = name === undefined ? "the application's own server" : `listener "${name}"`

      throw new ErrConfiguration(
        errMessage(`Cannot add route group "${meta.name}" to ${server}: it is bound to "${bound}"`)
          .solutions('Drop the binding: a plugin adds its group to the server it is registered on')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    if (name === undefined || bound !== undefined) {
      return compile(spec, meta)
    }

    return compile({ ...spec, labels: new Map([...(spec.labels ?? []), [kBindTo, name]]) }, meta)
  }
}

/**
 * Refuses a router bound to a name no installed server has. Nothing would serve it, and serving it on the
 * application's own server instead would expose what its binding kept off that server.
 */
function assertEveryRouterServed<R>(routing: Routing<R>, installed: readonly string[]): void {
  const [unserved] = routing.unselected()

  if (unserved === undefined) {
    return
  }

  const name = String(boundTo(unserved.spec.labels))
  const fixes = [`Add it: ".listener('${name}', ...)"`]

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
