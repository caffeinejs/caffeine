import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { Route, RouteGroup } from './route.js'

/**
 * Collects the compiled routes as Fastify registers them, regrouped under the group each was compiled in.
 *
 * Adds an `onRoute` hook to `instance`, so it sees the routes registered in that context — every route, for a
 * `fastify-plugin`-wrapped plugin on the root server. The returned function is complete once routes have
 * registered: call it from `onReady` or later. A group holds only the routes that registered, in registration
 * order, and a GET route's automatic HEAD twin is counted once.
 */
export function collectRouteGroups(instance: FastifyInstance): () => RouteGroup<FastifyRequest>[] {
  const groups = new Map<RouteGroup<FastifyRequest>, Set<Route<FastifyRequest>>>()

  instance.addHook('onRoute', options => {
    const meta = options.config?.$caffeine
    if (meta === undefined) {
      return
    }

    let routes = groups.get(meta.group)
    if (routes === undefined) {
      routes = new Set()
      groups.set(meta.group, routes)
    }

    routes.add(meta.route)
  })

  return () => Array.from(groups, ([group, routes]) => ({ ...group, routes: [...routes] }))
}
