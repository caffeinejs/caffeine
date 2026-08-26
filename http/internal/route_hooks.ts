import type { RouteOptions } from 'fastify'

/** The route hook slots anything in this package writes to. */
export type RouteHookKey = 'onRequest' | 'onSend'

/**
 * Adds a hook to a route's hook slot, allocating as little as the slot needs.
 *
 * Fastify accepts a single function or an array. Writing the function directly and only promoting to an
 * array on the second write means a route with one hook holds a function, a route with none holds
 * `undefined`, and no route pays for a slot it does not use. The alternative — normalizing every slot to an
 * array up front — allocated one array per hook key per route, which for an application with many routes and
 * few hooks is almost all waste.
 *
 * A hook the route itself declared (through `@Options`) is preserved and stays first.
 */
export function addRouteHook<K extends RouteHookKey>(
  routeDef: RouteOptions,
  key: K,
  fn: NonNullable<RouteOptions[K]>,
): void {
  const existing = routeDef[key]

  if (existing === undefined) {
    routeDef[key] = fn as RouteOptions[K]
    return
  }

  if (Array.isArray(existing)) {
    (existing as unknown[]).push(fn)
    return
  }

  routeDef[key] = [existing, fn] as RouteOptions[K]
}
