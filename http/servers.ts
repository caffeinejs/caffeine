import { errMessage } from '@caffeinejs/std/framework/err'

import type {
  IAdapter,
  AdapterExtensionFactory,
  IAdapterServer,
  IAdapterTypes,
  HTTPSetupContext,
  ServerConfigurer,
  ServerCustomizer,
} from './adapter.js'
import { normalizeBasePath } from './base_path.js'
import { boundTo, kBindTo } from './binding.js'
import { ErrConfiguration } from './core/error/common.js'
import type { RouteGroupCompiler, RouteGroupMeta } from './core/routing/compile.js'
import type { Router } from './core/routing/programmatic/programmatic.js'
import type { ScopedPlugins } from './core/routing/programmatic/scoped_plugins.js'
import { FluentRouteSource } from './core/routing/programmatic/source.js'
import type { IRouteGroup, RouteGroupScope } from './core/routing/route.js'
import type { Routing } from './core/routing/routing.js'
import type { RouteGroupSpec } from './core/routing/spec.js'
import { HTTPPlugin } from './plugin.js'
import { PluginSlot } from './plugin_slot.js'
import type { ServerDefinition } from './server_definition.js'

/** One server: the definition it is built from, the routers selected for it, and what the adapter built. */
interface Entry<T extends IAdapterTypes> {
  readonly definition: ServerDefinition<T>
  groups: IRouteGroup<T['request']>[]
  server?: IAdapterServer<T>
}

/** What every server is built with that is not its own. */
export interface ServerSetupInput<T extends IAdapterTypes> {
  /**
   * The application's, with a closed `app`: each server's own is this one with an `app` of its own and, for a named
   * server, a child logger.
   */
  readonly context: HTTPSetupContext
  /**
   * What routers and controllers asked for, resolved and installed in front of their groups on any server. What a
   * server's plugins mount is resolved into it too.
   */
  readonly plugins: ScopedPlugins<T>
  /** The compiler every group went through, for a group `$route` adds. */
  readonly compileRouteGroup: RouteGroupCompiler
}

/**
 * Every server an application runs, built one after another from its {@link ServerDefinition}, in order: the
 * application's own first, so it is the first to listen and the first to close.
 */
export class ServerSet<T extends IAdapterTypes> {
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
  get own(): IAdapterServer<T> | undefined {
    return this.#entries[0]?.server
  }

  /** The named servers, once {@link setup} has built them. */
  get named(): ReadonlyMap<string, IAdapterServer<T>> | undefined {
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
  select(routing: Routing<T['request']>): IRouteGroup<T['request']>[] {
    const compiled: IRouteGroup<T['request']>[] = []

    for (const entry of this.#entries) {
      const name = entry.definition.name
      entry.groups = routing.select(labels => boundTo(labels) === name)
      compiled.push(...entry.groups)
    }

    assertEveryRouterServed(routing, this.names)

    return compiled
  }

  /** Builds every server through `adapter`, one after another, each from its own definition. */
  async setup(adapter: IAdapter<T>, input: ServerSetupInput<T>): Promise<void> {
    for (const entry of this.#entries) {
      entry.server = await this.#build(entry, adapter, input)
    }
  }

  async #build(entry: Entry<T>, adapter: IAdapter<T>, input: ServerSetupInput<T>): Promise<IAdapterServer<T>> {
    const { definition } = entry
    const compile = serverCompiler(input.compileRouteGroup, definition.name)
    // What this server's plugins may do to the application: mount on it and add to its pipeline, while they register.
    const slot = new PluginSlot(definition.middlewares)
    const context = serverContext(input.context, definition.name, slot)

    // The server's own settings first: they describe what everything below registers onto, and a callback that
    // fails should do so before a factory with side effects has run.
    const server = await resolveServerOptions(definition.server, context)
    const basePath = normalizeBasePath(await definition.basePath?.(context))

    // Its own `.with(...)` factories, in the order they were written. The adapter installs the framework's head
    // slots ahead of them.
    const root = await slot.during(() => registerPlugins<T>(definition.plugins, context))

    // What the plugins mounted: those routers' own plugins first, since they may nest more, then the groups. A group
    // the application already serves on this server is served once, as a router mounted twice in one place is.
    await input.plugins.resolveRouters(slot.mounted, context)
    entry.groups.push(...compileMounted<T['request']>(slot.mounted, entry.groups, input.plugins, context, compile))

    return adapter.setup({
      routeGroups: entry.groups,
      compileRouteGroup: compile,
      context,
      middlewares: definition.middlewares,
      extensions: input.plugins.extensions.withRoot(root),
      server,
      customize: foldCustomizers(definition.customizers),
      basePath,
    })
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

/**
 * Folds every `.server(configure)` result into one, section by section: a section that is an object is
 * shallow-merged over the one before it, anything else replaces it as given. An object section is copied, never
 * aliased — a live configuration node is read-only, and the adapter writes into what it is handed.
 */
async function resolveServerOptions<T extends IAdapterTypes>(
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
function foldCustomizers<T extends IAdapterTypes>(
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

/** A server's own context: the application's, with this server's `app` and, for a named server, a child logger. */
function serverContext(base: HTTPSetupContext, name: string | undefined, app: PluginSlot): HTTPSetupContext {
  return { ...base, logger: name === undefined ? base.logger : base.logger.child({ server: name }), app }
}

/**
 * Runs a server's `.with(...)` factories in the order written: an `HTTPPlugin` registers in its slot, and anything
 * else is the adapter's to install, after the head slots.
 */
async function registerPlugins<T extends IAdapterTypes>(
  factories: readonly AdapterExtensionFactory<T['extension'] | HTTPPlugin<T>, unknown, T>[],
  context: HTTPSetupContext,
): Promise<T['extension'][]> {
  const root: T['extension'][] = []

  for (const factory of factories) {
    const extension = await factory(context as HTTPSetupContext<unknown, T>)

    if (extension instanceof HTTPPlugin) {
      await extension.register(context)
    } else {
      root.push(extension)
    }
  }

  return root
}

/**
 * What a server's plugins mounted, compiled as the application's own routers are and bound to that server, less the
 * groups it already `served`.
 */
function compileMounted<R>(
  routers: readonly Router<any, any, any, any, any, any>[],
  served: readonly IRouteGroup<unknown>[],
  plugins: ScopedPlugins<IAdapterTypes>,
  context: HTTPSetupContext,
  compile: RouteGroupCompiler,
): IRouteGroup<R>[] {
  return new FluentRouteSource<R>(routers, plugins.childrenOf)
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
function isServed(scopes: readonly RouteGroupScope[], groups: readonly IRouteGroup<unknown>[]): boolean {
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
  const fixes = [`Install it: ".install(Listener('${name}', ...))"`]

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
