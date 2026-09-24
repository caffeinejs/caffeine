import type {
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RouteGenericInterface,
  RouteOptions,
} from 'fastify'

import type { AnyRouteExtension } from '../extension.js'

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

/**
 * Fastify's own route options, minus the ones the router owns.
 *
 * What is left is the whole of what Fastify accepts and this package does not decide: every lifecycle hook,
 * `errorHandler`, the validator and serializer compilers, `attachValidation`, `logLevel`, `constraints`, `version`,
 * `exposeHeadRoute`, `prefixTrailingSlash`.
 *
 * The omissions are the keys the adapter writes for itself: `method` and `url` come from the verb and the path,
 * `schema` from `.schema()`, `bodyLimit` from `.bodyLimit()`, `handlerTimeout` from `.timeout()`, and `config`
 * carries what the request handler reads to apply the route's status, content type, headers and authentication.
 * `handler` is written after these options are applied and could never take effect.
 */
export type FastifyRouteOptions = Omit<
  AdapterRouteOptions,
  'method' | 'url' | 'handler' | 'schema' | 'config' | 'bodyLimit' | 'handlerTimeout'
>

/**
 * The Fastify escape hatch: options passed to the route as the adapter registers it.
 *
 * For what the router has no opinion about and no reason to grow one — a lifecycle hook, a custom serializer, a
 * route-level log level. A hook set here keeps its place ahead of the hooks attached for guards, the request
 * scope and any route contributor.
 *
 * ```ts
 * uploads
 *   .post('/')
 *   .with(fst({ attachValidation: true, logLevel: 'debug' }))
 *   .handler(ctx => ...)
 * ```
 */
export function fst(options: FastifyRouteOptions): AnyRouteExtension {
  const entries = Object.entries(options)

  return (target: { options(key: string, value: unknown): unknown }) => {
    for (const [key, value] of entries) {
      target.options(key, value)
    }
  }
}
