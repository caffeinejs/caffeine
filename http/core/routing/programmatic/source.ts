import type { Container } from '@caffeinejs/di'

import { bindGroup } from '../../../binding.js'
import type { RouteOptionsLevel } from '../options.js'
import type { DeclaredRouteGroup, RouteSource } from '../routing.js'
import type { ScopeChains } from '../scope_chain.js'
import { flattenRouter, type ChildrenOf, type FlatParent } from './flatten.js'
import type { Router } from './programmatic.js'
import { stateOf, type RouterState } from './state.js'

/**
 * The routes declared with {@link Router} and mounted on one server.
 *
 * Nothing here knows how a route is invoked beyond "call this function": the handler *is* the target, and the
 * arguments it takes are pickers, so the compiler's default dispatch covers it. What the source does is flatten
 * the routers it was given and hand the specs over — from there a programmatic route and a decorated one are the
 * same thing.
 */
export class FluentRouteSource<R = unknown> implements RouteSource<R> {
  readonly name = 'programmatic'

  readonly #routers: readonly Router<any, any, any, any, any>[]
  readonly #options: FluentRouteOptions<R>

  constructor(routers: readonly Router<any, any, any, any, any>[], options: FluentRouteOptions<R> = {}) {
    this.#routers = routers
    this.#options = options
  }

  collect(container: Container): DeclaredRouteGroup<R>[] {
    const groups: DeclaredRouteGroup<R>[] = []

    // Every value `.handler()` returns names the router it was opened from, so mounting routes declared as
    // separate statements hands the same state over more than once. All of these start at the same path, so the
    // second one is the first one's routes again.
    const seen = new Set<RouterState>()

    for (const router of this.#routers) {
      const state = stateOf(router)!

      if (seen.has(state)) {
        continue
      }

      seen.add(state)

      const { childrenOf, server, parent, levels } = this.#options
      for (const flat of flattenRouter<R>(state, container, childrenOf, parent, levels)) {
        const spec = server === undefined ? flat.spec : bindGroup(flat.spec, server)

        groups.push({ name: flat.name, spec, meta: () => ({ ...parent?.meta, name: flat.name }), scopes: flat.scopes })
      }
    }

    return groups
  }
}

/** Where and how a {@link FluentRouteSource} flattens its routers. */
export interface FluentRouteOptions<R> {
  /** A router's children as start-up sees them, when its plugins mounted more than it declared. */
  readonly childrenOf?: ChildrenOf
  /** The listener these routers are mounted on; `undefined` for the application's own server. */
  readonly server?: string
  /** What the routers nest under when a controller's plugin mounted them. */
  readonly parent?: FlatParent<R>
  /** Each place's own route-option levels, kept across the walks of one server. */
  readonly levels?: ScopeChains<RouteOptionsLevel[] | undefined>
}
