import { errMessage } from '@caffeinejs/std/framework/err'

import type {
  Adapter,
  AdapterExtensions,
  AdapterServer,
  AdapterTypes,
  HTTPSetupContext,
  ServerConfigurer,
  ServerCustomizer,
} from './adapter.js'
import { normalizeBasePath } from './base_path.js'
import { boundTo, kBindTo } from './binding.js'
import { ErrConfiguration } from './error/common.js'
import type { RouteGroupCompiler, RouteGroupMeta } from './routing/compile.js'
import type { RouteGroup } from './routing/route.js'
import type { Routing } from './routing/routing.js'
import type { RouteGroupSpec } from './routing/spec.js'
import type { ServerDefinition } from './server_definition.js'

/** One server: the definition it is built from, the routers selected for it, and what the adapter built. */
interface Entry<T extends AdapterTypes> {
  readonly definition: ServerDefinition<T>
  groups: RouteGroup<T['request']>[]
  server?: AdapterServer<T>
}

/** What every server is built with that is not its own. */
export interface ServerSetupInput<T extends AdapterTypes> {
  /** The application's: a named server's own is this one with a child logger. */
  readonly context: HTTPSetupContext
  /** The framework's head slots, built fresh for one server: error handling, then cookies. */
  headSlots(): T['extension'][]
  /** What routers and controllers asked for, resolved once and installed in front of their groups on any server. */
  scopedExtensions(): Promise<AdapterExtensions<T['extension']>>
  /** The compiler every group went through, for a group `$route` adds. */
  readonly compileRouteGroup: RouteGroupCompiler
}

/**
 * Every server an application runs, built one after another from its {@link ServerDefinition}, in order: the
 * application's own first, so it is the first to listen and the first to close.
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
   * Compiles the routers bound to each server, and refuses one bound to no server. Returns every group compiled,
   * for the application's route table.
   *
   * @throws ErrConfiguration for a router bound to a name no server has.
   */
  select(routing: Routing<T['request']>): RouteGroup<T['request']>[] {
    const compiled: RouteGroup<T['request']>[] = []

    for (const entry of this.#entries) {
      const name = entry.definition.name
      entry.groups = routing.select(labels => boundTo(labels) === name)
      compiled.push(...entry.groups)
    }

    assertEveryRouterServed(routing, this.names)

    return compiled
  }

  /** Builds every server through `adapter`, one after another, each from its own definition. */
  async setup(adapter: Adapter<T>, input: ServerSetupInput<T>): Promise<void> {
    let scoped: AdapterExtensions<T['extension']> | undefined

    for (const entry of this.#entries) {
      const { definition } = entry
      const context: HTTPSetupContext =
        definition.name === undefined
          ? input.context
          : { ...input.context, logger: input.context.logger.child({ server: definition.name }) }

      // The server's own settings first: they describe what everything below registers onto, and a callback that
      // fails should do so before a factory with side effects has run.
      const server = await resolveServerOptions(definition.server, context)
      const basePath = normalizeBasePath(await definition.basePath?.(context))

      // The framework's head slots, then its own `.with(...)` factories, in the order they were written.
      const root = input.headSlots()
      for (const factory of definition.plugins) {
        root.push(await factory(context))
      }

      // Once, after the first server's own: every server installs them in front of the groups it serves.
      scoped ??= await input.scopedExtensions()

      entry.server = await adapter.setup({
        routeGroups: entry.groups,
        compileRouteGroup: serverCompiler(input.compileRouteGroup, definition.name),
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
 * What `$route` compiles a group with on the server named `name`: a group bound to another server is refused, since
 * that server would never see it, and an unbound one is bound to this one, as every group it serves is.
 */
function serverCompiler(compile: RouteGroupCompiler, name: string | undefined): RouteGroupCompiler {
  return <R>(spec: RouteGroupSpec<R>, meta: RouteGroupMeta<R>): RouteGroup<R> => {
    const bound = boundTo(spec.labels)

    if (bound !== undefined && bound !== name) {
      const server = name === undefined ? "the application's own server" : `ops server "${name}"`

      throw new ErrConfiguration(
        errMessage(`Cannot add route group "${meta.name}" to ${server}: it is bound to "${bound}"`)
          .solutions('Drop the binding: "$route" adds the group to the server its plugin runs on')
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
