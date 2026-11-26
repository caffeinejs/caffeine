import type { ConstraintStrategy } from '../constraints/constraints.js'
import { ErrCaffeineWebApplication } from '../error/common.js'

/** Constraint values derived from the request, matched against a route's own. */
export type DerivedConstraints = Readonly<Record<string, unknown>>

/** The route a request names, as a {@link RouteMatcher} found it. */
export interface RouteMatch<S> {
  readonly store: S
  /** Parameter values by name, each its segment decoded whole; a wildcard's under `*`. */
  readonly params: Readonly<Record<string, string | undefined>>
}

/** Finds the route a request names. The engine registers every route before the first match. */
export interface RouteMatcher<S> {
  /**
   * Registers a route. `path` is written in Caffeine's route syntax, as `parseRoutePattern` reads it, and ends in no
   * `/` but the root `/`. Caffeine checks no path it hands over: the matcher refuses one it cannot register, a
   * malformed one included, and a matcher for another router translates it to that router's own.
   *
   * @throws ErrRouteConflict when a route of `method` already matches `path` under these constraints.
   * @throws ErrConfiguration when `path` or `method` is not one the matcher can register.
   */
  add(method: string, path: string, constraints: DerivedConstraints | undefined, store: S): void

  /**
   * The route the request path names: `null` when none matches. `path` is `ctx.req.path`: without the query, every
   * escape decoded but those of `#`, `$`, `&`, `+`, `,`, `/`, `:`, `;`, `=`, `?`, `@` and `%`, so `%2F` never
   * separates two segments. The matcher compares it as given, case-sensitively, and does not decode it again; a
   * trailing `/` matches as the path without it, and a `%` in a route's text matches `%25`. A parameter, with any text
   * after it in its segment, is matched against that segment decoded whole.
   */
  match(method: string, path: string, constraints: DerivedConstraints | undefined): RouteMatch<S> | null
}

/**
 * Builds the matcher of one server from its custom constraint strategies. Each call builds a new matcher, independent
 * of every other, so a plugin may build one with the server's factory to ask how the server ranks routes. Every
 * matcher implements the two built-in constraints, `version` (a semver range a request names with `Accept-Version`)
 * and `host` (its `Host`); a strategy of either name replaces it.
 */
export type RouteMatcherFactory = <S>(strategies: readonly ConstraintStrategy<unknown>[]) => RouteMatcher<S>

/**
 * A route of that method already matches that path. What a second registration of a route meets, and what a GET's
 * automatic HEAD route meets beside an explicit HEAD route, which it then gives way to. A custom
 * {@link RouteMatcher} throws it for the same case.
 */
export class ErrRouteConflict extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_ROUTE_CONFLICT')
    this.name = 'ErrRouteConflict'
  }
}
