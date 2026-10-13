import type { Container } from '@caffeinejs/di'

import type { DeclaredRouteGroup, RouteSource } from '../routing.js'
import { stateOf, type RouterState } from './_state.js'
import { flattenRouter } from './flatten.js'
import type { Router } from './router.js'

/**
 * The routes declared with {@link Router} and mounted into the application.
 *
 * Nothing here knows how a route is invoked beyond "call this function": the handler *is* the target, and the
 * arguments it takes are pickers, so the compiler's default dispatch covers it. What the source does is flatten
 * the routers it was given and hand the specs over — from there a programmatic route and a decorated one are the
 * same thing.
 */
export class FluentRouteSource<R = unknown> implements RouteSource<R> {
  readonly name = 'programmatic'

  readonly #routers: readonly Router<any, any, any, any, any, any>[]
  readonly #childrenOf: ((state: RouterState) => readonly RouterState[]) | undefined

  /**
   * @param childrenOf - A router's children as start-up sees them, when its plugins mounted more than it declared.
   */
  constructor(
    routers: readonly Router<any, any, any, any, any, any>[],
    childrenOf?: (state: RouterState) => readonly RouterState[],
  ) {
    this.#routers = routers
    this.#childrenOf = childrenOf
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

      for (const flat of flattenRouter<R>(state, container, this.#childrenOf)) {
        groups.push({ name: flat.name, spec: flat.spec, meta: () => ({ name: flat.name }), scopes: flat.scopes })
      }
    }

    return groups
  }
}
