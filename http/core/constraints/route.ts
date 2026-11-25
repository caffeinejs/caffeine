import { RouteOptions } from '../routing/options.js'
import { kVersionHeader, VERSION_CONSTRAINT, type ResolvedRouteConstraint } from './keys.js'

declare module '../routing/options.js' {
  interface RouteOptions {
    /**
     * Read by the constraint matcher: the constraints this route selects on, by name. A Map adds to what the route's
     * groups set, name by name; `null` drops every one of them, for a route that must match whatever its router
     * selects on, and a Map set after it on the same route or router is then all it selects on.
     */
    constraints?: Map<string, ResolvedRouteConstraint> | null
  }
}

/**
 * Route options that select on a registered route constraint, applied with `.config(constraint(name, value))` on
 * a route or a router. The server matches on it by itself. A route's constraint replaces the same name from its router
 * and keeps the others: a route of a versioned router stays versioned.
 */
export function constraint(name: string, value: unknown, options?: { header?: string }): Partial<RouteOptions> {
  return { constraints: new Map([[name, { value, header: options?.header }]]) }
}

/**
 * Selects the route — or every route of the group, on a class — when the request carries `value` for the
 * constraint `name`.
 *
 * Nothing is installed for it; a name other than `version` and `host` needs its strategy in `.server(...)`'s
 * `constraints`. A route whose constraint the request does not satisfy is not matched, and the request is answered
 * 404. The programmatic form is {@link constraint}, applied with `.config(constraint(name, value))`.
 */
export function Constraint(name: string, value: unknown, options?: { header?: string }) {
  return RouteOptions(constraint(name, value, options))
}

/**
 * Route options binding routes to an API version. One implementation behind {@link Version}, applied with
 * `.config(version(v))` on a route or a router.
 */
export function version(version: string): Partial<RouteOptions> {
  return constraint(VERSION_CONSTRAINT, version, { header: kVersionHeader })
}

/**
 * Binds the route — or every route of the group, on a class — to an API version selected by the `Accept-Version`
 * request header.
 *
 * `version` is a semver string, e.g. `'1.0.0'`; a request matches it with `Accept-Version: 1`, `1.x` or
 * `1.0.0`, and when several versions satisfy the header the highest wins. A request that sends no
 * `Accept-Version` does not match a versioned route.
 *
 * Sugar for `@Constraint('version', v)`; nothing is installed for it. URI versioning is a separate concern — use
 * `@Prefix('/v1')`.
 */
export function Version(v: string) {
  return Constraint(VERSION_CONSTRAINT, v, { header: kVersionHeader })
}
