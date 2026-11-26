import type { HTTPPluginFactory, HTTPSetupContext } from '../../../plugin.js'
import { PluginSlot, type SlotIdentity } from '../../../plugin_slot.js'
import type { HookBatch } from '../../lifecycle/batch.js'
import { MiddlewarePipeline, type ResolvedMiddleware } from '../../middleware/pipeline.js'
import type { RouteGroupScope } from '../route.js'
import { ScopeChains } from '../scope_chain.js'
import { assertNotNestedInItself, scopePathOf } from './flatten.js'
import type { AnyRouter } from './programmatic.js'
import { stateOf, type RouterState } from './state.js'

type ScopeFactory = HTTPPluginFactory<any>

/** What one place's plugins left: their slot, their hooks, their middleware, and the routers they mounted. */
interface Registered {
  readonly slot: PluginSlot
  readonly batches: HookBatch[]
  middlewares: readonly ResolvedMiddleware[]
  mounted: readonly AnyRouter[]
}

const NONE: readonly never[] = []

/**
 * The plugins of the routers and controllers one server serves, run on that server after its own plugins, once per
 * place each is mounted at.
 *
 * A place is a mount chain: a router or a controller with every router it is nested in. A router's `.with(...)` and a
 * controller's `@Use(...)` factories run here, each plugin handed `context.server` scoped to that place: its middleware
 * runs in front of that scope's routes, with paths relative to it, and what it mounts nests under it. What it mounts is
 * kept here, never written into the router, so a router mounted in two places, or into two applications, starts from
 * what it declared in each.
 */
export class ScopedPlugins {
  readonly #server: PluginSlot
  readonly #identity: SlotIdentity
  readonly #places = new ScopeChains<Registered>()
  /** Every place's hooks, in the order they registered. */
  readonly #batches: HookBatch[] = []
  #routersMounted = false

  /**
   * @param server - The server's own slot, around every scope.
   * @param identity - The server every scope belongs to.
   */
  constructor(server: PluginSlot, identity: SlotIdentity) {
    this.#server = server
    this.#identity = identity
  }

  /**
   * A router's children at one place, its mount chain `scopes`, as start-up sees them: those it declared, then those
   * its plugins mounted there.
   */
  readonly childrenOf = (state: RouterState, scopes: readonly RouteGroupScope[]): readonly RouterState[] => {
    const mounted = this.#places.get(scopes)?.mounted ?? NONE
    return mounted.length === 0 ? state.children : [...state.children, ...mounted.map(router => stateOf(router)!)]
  }

  /** The hooks the place `scopes[0..at]` installs in front of its own routes. */
  batchesOf(scopes: readonly RouteGroupScope[], at: number): readonly HookBatch[] {
    return this.#places.get(scopes, at)?.batches ?? NONE
  }

  /**
   * The middleware the plugins of the place `scopes[0..at]` added, run in front of its routes after its plugins. Paths
   * are relative to it: the engine rebases them under its path.
   */
  middlewaresOf(scopes: readonly RouteGroupScope[], at: number): readonly ResolvedMiddleware[] {
    return this.#places.get(scopes, at)?.middlewares ?? NONE
  }

  /** Every scope's hooks, in the order they registered: their server hooks run whatever routes the scope holds. */
  get batches(): readonly HookBatch[] {
    return this.#batches
  }

  /** Whether a router's plugin mounted something: what the server's routers serve grew. */
  get routersMounted(): boolean {
    return this.#routersMounted
  }

  /**
   * Runs the `.with(...)` factories of every router reachable from `routers` at each place it is mounted, parents
   * before children, the routers those factories nest included. `routers` are mounted at this server's root.
   */
  async resolveRouters(routers: readonly AnyRouter[], context: HTTPSetupContext): Promise<void> {
    for (const router of routers) {
      await this.#visit(stateOf(router)!, '', NONE, this.#server, context, [])
    }
  }

  /**
   * Runs a controller's `@Use(...)` factories at its place, then the plugins of the routers they mounted, which nest
   * under the controller. Resolves to those routers; none for a place already resolved.
   */
  async resolveController(
    scope: RouteGroupScope,
    factories: readonly ScopeFactory[],
    context: HTTPSetupContext,
  ): Promise<readonly AnyRouter[]> {
    const chain = [scope]
    if (this.#places.has(chain)) {
      return NONE
    }

    const where = `on controller "${(scope.key as Function).name}"`
    const registered = await this.#resolve(chain, factories, this.#server, context, where)

    for (const router of registered.mounted) {
      await this.#visit(stateOf(router)!, scope.path, chain, registered.slot, context, [])
    }

    return registered.mounted
  }

  async #visit(
    state: RouterState,
    parentPath: string,
    parentChain: readonly RouteGroupScope[],
    parent: PluginSlot,
    context: HTTPSetupContext,
    stack: RouterState[],
  ): Promise<void> {
    // Before its plugins run: a router nested in itself, through any mount, would otherwise be visited without end.
    assertNotNestedInItself(state, stack)
    stack.push(state)

    try {
      const path = scopePathOf(parentPath, state.builder.toRouteGroup().prefix, state)
      const chain = [...parentChain, { key: state, path }]

      let registered = this.#places.get(chain)
      if (registered === undefined) {
        const where = `on router "${state.name ?? state.path}"`
        registered = await this.#resolve(chain, state.plugins, parent, context, where)
        this.#routersMounted ||= registered.mounted.length > 0
      }

      // After the router's own plugins, so the routers they mounted are visited too.
      for (const child of this.childrenOf(state, chain)) {
        await this.#visit(child, path, chain, registered.slot, context, stack)
      }
    } finally {
      stack.pop()
    }
  }

  /** Runs one place's factories in its own slot, scoped to that place. */
  async #resolve(
    chain: readonly RouteGroupScope[],
    factories: readonly ScopeFactory[],
    parent: PluginSlot,
    context: HTTPSetupContext,
    where: string,
  ): Promise<Registered> {
    const middlewares = new MiddlewarePipeline()
    const slot = new PluginSlot(middlewares, chain.at(-1)!.path, parent)
    slot.forServer(this.#identity)
    const scoped: HTTPSetupContext = { ...context, server: slot }

    // Recorded first: a place is resolved once, whatever its plugins do.
    const registered = this.#places.at(chain, () => ({ slot, batches: [], middlewares: NONE, mounted: NONE }))

    await slot.during(async () => {
      for (const factory of factories) {
        // The hooks it adds keep its place among the scope's plugins, kept as it starts: one that fails partway still
        // closes what it opened.
        await slot.run(factory, scoped, where, batch => {
          registered.batches.push(batch)
          this.#batches.push(batch)
        })
      }
    })

    // Factories run here, handed the scope's context once its slot has closed, so a middleware factory cannot mount.
    registered.middlewares = middlewares.resolve(scoped)
    registered.mounted = adopt(chain.at(-1)!.key, slot.mounted)

    return registered
  }
}

// Siblings only, as `Router.mount` adopts: the same router twice under one place is the same routes twice, and one the
// router declares is already its child.
function adopt(key: object, routers: readonly AnyRouter[]): readonly AnyRouter[] {
  const declared: readonly RouterState[] = typeof key === 'function' ? NONE : (key as RouterState).children
  const adopted: AnyRouter[] = []
  const seen = new Set<RouterState>()

  for (const router of routers) {
    const child = stateOf(router)!
    if (!declared.includes(child) && !seen.has(child)) {
      seen.add(child)
      adopted.push(router)
    }
  }

  return adopted
}
