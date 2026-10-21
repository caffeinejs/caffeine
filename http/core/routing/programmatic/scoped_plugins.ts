import {
  AdapterExtensions,
  type AdapterExtensionFactory,
  type IAdapterTypes,
  type HTTPSetupContext,
} from '../../../adapter.js'
import { HTTPPlugin } from '../../../plugin.js'
import { PluginSlot } from '../../../plugin_slot.js'
import { MiddlewarePipeline } from '../../middleware/pipeline.js'
import type { AnyRouter } from './programmatic.js'
import { stateOf, type RouterState } from './state.js'

type ScopeFactory = AdapterExtensionFactory<unknown, unknown, any>

/**
 * The plugins an application's routers and controllers registered for themselves, resolved once each during
 * start-up and installed in front of their own routes on whichever server serves them.
 *
 * A router's `.with(...)` and a controller's `@Use(...)` factories run here. An `HTTPPlugin` registers with
 * `context.app` scoped to its router or controller: its middleware runs in front of that scope's routes, with paths
 * relative to it, and what a router's plugin mounts nests under the router. What it mounts is kept here, never
 * written into the router, so the same router mounted into two applications starts from what it declared in both.
 */
export class ScopedPlugins<T extends IAdapterTypes> {
  /** Per router or controller: the adapter's plugins, and the middleware its plugins added. */
  readonly extensions = new AdapterExtensions<T['extension']>()

  readonly #resolved = new Set<RouterState>()
  readonly #mounted = new Map<RouterState, RouterState[]>()

  /** A router's children as start-up sees them: those it declared, then those its plugins mounted. */
  readonly childrenOf = (state: RouterState): readonly RouterState[] => {
    const mounted = this.#mounted.get(state)
    return mounted === undefined ? state.children : [...state.children, ...mounted]
  }

  /**
   * Runs the `.with(...)` factories of every router reachable from `routers` that has not run them yet, parents
   * before children, the routers those factories nest included.
   */
  async resolveRouters(routers: readonly AnyRouter[], context: HTTPSetupContext): Promise<void> {
    for (const router of routers) {
      await this.#visit(stateOf(router)!, context)
    }
  }

  /** Runs a controller's `@Use(...)` factories. Its plugins add middleware; they cannot mount. */
  async resolveController(key: Function, factories: readonly ScopeFactory[], context: HTTPSetupContext): Promise<void> {
    await this.#resolve(key, factories, context, false)
  }

  async #visit(state: RouterState, context: HTTPSetupContext): Promise<void> {
    if (this.#resolved.has(state)) {
      return
    }

    this.#resolved.add(state)
    this.#adopt(state, await this.#resolve(state, state.plugins, context, true))

    // After the router's own plugins, so the routers they mounted are visited too.
    for (const child of this.childrenOf(state)) {
      await this.#visit(child, context)
    }
  }

  /** Runs one scope's factories in its own slot. Resolves to what its plugins mounted. */
  async #resolve(
    key: object,
    factories: readonly ScopeFactory[],
    context: HTTPSetupContext,
    mountable: boolean,
  ): Promise<readonly AnyRouter[]> {
    const middlewares = new MiddlewarePipeline()
    const slot = new PluginSlot(middlewares, mountable)
    const scoped: HTTPSetupContext = { ...context, app: slot }

    await slot.during(async () => {
      for (const factory of factories) {
        const extension = await factory(scoped)

        if (extension instanceof HTTPPlugin) {
          await extension.register(scoped)
        } else {
          // Unchecked: the adapter refuses what it cannot install.
          this.extensions.add(extension as T['extension'], key)
        }
      }
    })

    // Factories run here, handed the context outside the slot, so a middleware factory cannot mount.
    const resolved = middlewares.resolve(context)
    if (resolved.length > 0) {
      this.extensions.addMiddlewares(key, resolved)
    }

    return slot.mounted
  }

  // Siblings only, as `Router.mount` adopts: the same router twice under one parent is the same routes twice. Called
  // once per router, since a router's plugins run once.
  #adopt(state: RouterState, routers: readonly AnyRouter[]): void {
    const mounted: RouterState[] = []

    for (const router of routers) {
      const child = stateOf(router)!
      if (!state.children.includes(child) && !mounted.includes(child)) {
        mounted.push(child)
      }
    }

    if (mounted.length > 0) {
      this.#mounted.set(state, mounted)
    }
  }
}
