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
 *
 * One source serves the whole application: each server's routing pass adds what was mounted on it, and a router is
 * declared once however many times, and from however many places, it was mounted.
 */
export class FluentRouteSource<R = unknown> implements RouteSource<R> {
  readonly name = 'programmatic'

  readonly #pending: Router<any, any, any, any, any, any>[] = []

  // Every value `.handler()` returns names the router it was opened from, so mounting routes declared as separate
  // statements hands the same state over more than once. All of these start at the same path, so the second one is
  // the first one's routes again.
  readonly #seen = new Set<RouterState>()

  constructor(routers: readonly Router<any, any, any, any, any, any>[] = []) {
    this.#pending.push(...routers)
  }

  /** Adds routers for the next {@link collect}. */
  add(routers: readonly Router<any, any, any, any, any, any>[]): this {
    this.#pending.push(...routers)
    return this
  }

  /** The groups of every router added since the last call whose state no earlier call declared. */
  collect(container: Container): DeclaredRouteGroup<R>[] {
    const groups: DeclaredRouteGroup<R>[] = []

    for (const router of this.#pending.splice(0)) {
      const state = stateOf(router)!

      if (this.#seen.has(state)) {
        continue
      }

      this.#seen.add(state)

      for (const flat of flattenRouter<R>(state, container)) {
        groups.push({ name: flat.name, spec: flat.spec, meta: () => ({ name: flat.name }), scopes: flat.scopes })
      }
    }

    return groups
  }
}

/** Every router state reachable from `routers`, parents before children, each one seen once. */
export function routerStates(routers: readonly Router<any, any, any, any, any, any>[]): RouterState[] {
  const out: RouterState[] = []
  const seen = new Set<RouterState>()

  const visit = (state: RouterState): void => {
    if (seen.has(state)) {
      return
    }

    seen.add(state)
    out.push(state)

    for (const child of state.children) {
      visit(child)
    }
  }

  for (const router of routers) {
    visit(stateOf(router)!)
  }

  return out
}
