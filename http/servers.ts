import type { ContextKey } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import { normalizeBasePath } from './base_path.js'
import { boundTo } from './binding.js'
import { ErrConfiguration } from './core/error/common.js'
import type { HookBatch } from './core/lifecycle/batch.js'
import type { RouteGroupCompiler } from './core/routing/compile.js'
import { controllerSetup } from './core/routing/decorated.js'
import { kCompleteInventory, kRecordServer, type RouteInventory } from './core/routing/inventory.js'
import type { FlatParent } from './core/routing/programmatic/flatten.js'
import type { AnyRouter } from './core/routing/programmatic/programmatic.js'
import { ScopedPlugins } from './core/routing/programmatic/scoped_plugins.js'
import { FluentRouteSource, type FluentRouteOptions } from './core/routing/programmatic/source.js'
import type { IRouteGroup, RouteGroupScope } from './core/routing/route.js'
import type { Routing } from './core/routing/routing.js'
import type { Context } from './core/server/context.js'
import {
  buildEngine,
  findMyWayFlags,
  type AnyServerAdapter,
  type HostedServer,
  type kHosting,
} from './core/server/hosting.js'
import type { HTTPServer } from './core/server/server.js'
import { getRouteGroup } from './decorators/registrar/registrar.js'
import type { HTTPPluginFactory, HTTPSetupContext } from './plugin.js'
import { PluginSlot, type SlotIdentity } from './plugin_slot.js'
import type { ServerConfigurer } from './server.js'
import type { ServerDefinition } from './server_definition.js'

/** One server: the definition it is built from, the routers selected for it, and what was built. */
interface Entry {
  readonly definition: ServerDefinition
  groups: IRouteGroup<Context>[]
  server?: HostedServer
  engine?: HTTPServer
  /** The hooks of the plugins that registered when start-up failed before an engine took them over. */
  stranded?: readonly HookBatch[]
}

/** What every server is built with that is not its own. */
export interface ServerSetupInput {
  /**
   * The application's, with no `server`: each server's own is this one with its scoped server and, for a named server,
   * a child logger.
   */
  readonly context: Omit<HTTPSetupContext, 'server'>
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
   * Compiles the groups each server serves, and refuses a controller bound to no server. Returns every group
   * compiled, for the application's route table.
   *
   * @throws ErrConfiguration for a controller bound to a name no server has.
   */
  select(routing: Routing<Context>): IRouteGroup<Context>[] {
    const compiled: IRouteGroup<Context>[] = []

    for (const entry of this.#entries) {
      const name = entry.definition.name
      entry.groups = routing.select(labels => boundTo(labels) === name)
      compiled.push(...entry.groups)
    }

    assertEveryControllerServed(routing, this.names)

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
    // The server as its plugins see it: they mount on it and add to its pipeline while they register.
    const slot = new PluginSlot(definition.middlewares)
    const base = serverLogger(input.context, definition.name)

    // The server's own settings first: they describe what everything below registers onto, and a callback that
    // fails should do so before a factory with side effects has run. They build the server, so they get no `server`.
    const settings = await resolveServerOptions(definition.server, base)
    const basePath = normalizeBasePath(await definition.basePath?.(base))
    const hosting = input.hosting(settings)
    const identity: SlotIdentity = {
      name: definition.name,
      basePath: basePath ?? '',
      router: findMyWayFlags(hosting.settings),
      address: () => entry.server?.address,
    }
    slot.forServer(identity)
    const context: HTTPSetupContext = { ...base, server: slot }

    // Its own `.with(...)` factories, in the order they were written. The engine installs the framework's head
    // slots ahead of them.
    const where = definition.name === undefined ? "on the application's own server" : `on listener "${definition.name}"`
    const root: HookBatch[] = []
    const scoped = new ScopedPlugins(slot, identity)
    const engine = await strandOnFailure(entry, root, scoped, async () => {
      await slot.during(() => registerPlugins(definition.plugins, context, slot, where, root))

      // Then the plugins of what it serves, each scoped to its place: the routers mounted on it and those its plugins
      // mounted, parents before children, then its controllers.
      await scoped.resolveRouters([...definition.routers, ...slot.mounted], context)
      const controllerMounts: Array<{ routers: readonly AnyRouter[]; parent: FlatParent<Context> }> = []
      for (const scope of controllerScopes(entry.groups)) {
        const spec = getRouteGroup(scope.key as Function)!.toRouteGroup<Context>()
        const routers = await scoped.resolveController(scope, spec.plugins ?? [], context)
        if (routers.length > 0) {
          const meta = controllerSetup(scope.key as Function, spec, context.container)
          controllerMounts.push({ routers, parent: { spec, path: scope.path, scopes: [scope], meta } })
        }
      }

      // What the plugins mounted, compiled as the server's own routers are: under the routers whose plugins mounted
      // them, at its root, or under a controller. A group the server already serves is served once, as a router
      // mounted twice in one place is: each batch joins the served groups before the next is compiled.
      const compile = (routers: readonly AnyRouter[], parent?: FlatParent<Context>): void => {
        entry.groups.push(
          ...compileMounted(routers, entry.groups, context, input.compileRouteGroup, {
            childrenOf: scoped.childrenOf,
            server: definition.name,
            parent,
            levels: definition.levels,
          }),
        )
      }
      if (scoped.routersMounted) {
        compile(definition.routers)
      }
      compile(slot.mounted)
      for (const { routers, parent } of controllerMounts) {
        compile(routers, parent)
      }

      return buildEngine({
        contextKey: input.contextKey,
        routeGroups: entry.groups,
        context,
        middlewares: definition.middlewares,
        root,
        scoped,
        basePath,
        settings: hosting.settings,
        recordRoutes: routes =>
          input.inventory[kRecordServer]({ server: definition.name, basePath: basePath ?? '', routes }),
      })
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
   * Closes every server built, and the engine of a server whose build failed after its engine was built. For a server
   * whose build failed before then, runs the `onClose` of the plugins that had registered, once. Closes the rest even
   * when one fails. Resolves to what failed: every `onClose` of those plugins that failed, where a built engine logs
   * each and rejects with the first.
   */
  async teardown(): Promise<unknown[]> {
    const failures: unknown[] = []

    for (const entry of this.#entries) {
      try {
        if (entry.server !== undefined || entry.engine !== undefined) {
          await (entry.server?.teardown() ?? entry.engine?.close())
        } else {
          failures.push(...(await closeStranded(entry)))
        }
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
  context: Omit<HTTPSetupContext, 'server'>,
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

/** The application's context with, for a named server, a child logger. */
function serverLogger(
  base: Omit<HTTPSetupContext, 'server'>,
  name: string | undefined,
): Omit<HTTPSetupContext, 'server'> {
  return name === undefined ? base : { ...base, logger: base.logger.child({ server: name }) }
}

/** The scope of each controller in `groups`: a controller's group carries one only when it registered plugins. */
function controllerScopes(groups: readonly IRouteGroup<Context>[]): RouteGroupScope[] {
  return groups.flatMap(group => (group.scopes ?? []).filter(scope => typeof scope.key === 'function'))
}

/**
 * Builds a server's engine with `build`, which registers its plugins first. A failure before the engine exists leaves
 * the hooks of the plugins that registered on `entry`, for teardown to run their `onClose`.
 */
async function strandOnFailure(
  entry: Entry,
  root: readonly HookBatch[],
  scoped: ScopedPlugins,
  build: () => Promise<HTTPServer>,
): Promise<HTTPServer> {
  try {
    return await build()
  } catch (err) {
    entry.stranded = [...root, ...scoped.batches]
    throw err
  }
}

/** Runs every `onClose` the entry's stranded hooks hold, once, each with its own context. Resolves to what failed. */
async function closeStranded(entry: Entry): Promise<unknown[]> {
  const failures: unknown[] = []
  const batches = entry.stranded ?? []
  entry.stranded = undefined

  for (const batch of batches) {
    for (const onClose of batch.onClose) {
      try {
        await onClose(batch.kit)
      } catch (err) {
        failures.push(err)
      }
    }
  }

  return failures
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
  root: HookBatch[],
): Promise<void> {
  for (const factory of factories) {
    await slot.run(factory, context, where, batch => root.push(batch))
  }
}

/**
 * What the plugins on a server mounted, under its `routers` or at its root, compiled as the application's own routers
 * are and labelled with that server, less the groups it already `served`: the routers' declared groups among them.
 */
function compileMounted(
  routers: readonly AnyRouter[],
  served: readonly IRouteGroup<Context>[],
  context: HTTPSetupContext,
  compile: RouteGroupCompiler,
  options: FluentRouteOptions<Context>,
): IRouteGroup<Context>[] {
  if (routers.length === 0) {
    return []
  }

  return new FluentRouteSource<Context>(routers, options)
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
  // Per group, never per router: a group is the one already served only when its whole chain of routers is.
  return groups.some(
    group => group.scopes?.length === scopes.length && group.scopes.every((scope, at) => scope.key === scopes[at].key),
  )
}

/**
 * Refuses a controller bound with `@BindTo` to a name no installed server has. Nothing would serve it, and serving it
 * on the application's own server instead would expose what its binding kept off that server.
 */
function assertEveryControllerServed<R>(routing: Routing<R>, installed: readonly string[]): void {
  const [unserved] = routing.unselected()

  if (unserved === undefined) {
    return
  }

  const name = String(boundTo(unserved.spec.labels))
  const fixes = [`Add it: ".listener('${name}', ...)"`]

  if (installed.length > 0) {
    const names = installed.map(candidate => `"${candidate}"`).join(', ')
    fixes.push(`Or bind it to an installed server: ${names}`)
  }

  throw new ErrConfiguration(
    errMessage(
      `Cannot serve controller "${unserved.name}": it is bound to "${name}" with @BindTo, and no installed server has that name`,
    )
      .solutions(...fixes)
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
