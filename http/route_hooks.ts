import type {
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RouteGenericInterface,
  RouteOptions,
} from 'fastify'

/** Fastify route options parameterized for HTTP/1 and HTTP/2. */
export type AdapterRouteOptions = RouteOptions<
  RawServerBase,
  RawRequestDefaultExpression<RawServerBase>,
  RawReplyDefaultExpression<RawServerBase>,
  RouteGenericInterface,
  any
>

type AdapterOnRequestFn = Extract<
  NonNullable<AdapterRouteOptions['onRequest']>,
  (request: never, reply: never, ...args: never[]) => unknown
>

/** Request type carried on {@link AdapterRouteOptions} hooks. */
export type AdapterRequest = Parameters<AdapterOnRequestFn>[0]

/** Reply type carried on {@link AdapterRouteOptions} hooks. */
export type AdapterReply = Parameters<AdapterOnRequestFn>[1]

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
 * A hook the route itself declared (through `fst`) is preserved and stays first. An array already in the slot is
 * replaced, never mutated: Fastify hands the same array to a GET route's automatic HEAD twin, and a group-level
 * `fst({ onSend: [...] })` hands one array to every route in the group.
 */
export function addRouteHook<K extends RouteHookKey>(
  routeDef: AdapterRouteOptions,
  key: K,
  fn: NonNullable<AdapterRouteOptions[K]>,
): void {
  const existing = routeDef[key]

  if (existing === undefined) {
    routeDef[key] = fn as AdapterRouteOptions[K]
    return
  }

  if (Array.isArray(existing)) {
    routeDef[key] = [...(existing as unknown[]), fn] as AdapterRouteOptions[K]
    return
  }

  routeDef[key] = [existing, fn] as AdapterRouteOptions[K]
}
