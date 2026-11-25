import type { ConstraintStrategy } from '../constraints/constraints.js'
import { ErrCaffeineWebApplication } from '../error/common.js'

/** How a server's router matches a request's path. */
export interface RouterFlags {
  readonly caseSensitive: boolean
  readonly ignoreTrailingSlash: boolean
  readonly ignoreDuplicateSlashes: boolean
  /** Whether `;` starts the query, as `?` does. */
  readonly useSemicolonDelimiter: boolean
}

// find-my-way's own defaults, which Fastify keeps.
export const DEFAULT_ROUTER_FLAGS: RouterFlags = {
  caseSensitive: true,
  ignoreTrailingSlash: false,
  ignoreDuplicateSlashes: false,
  useSemicolonDelimiter: false,
}

/** Constraint values derived from the request, matched against a route's own. */
export type DerivedConstraints = Readonly<Record<string, unknown>>

/** The route a request names, as a {@link RouteMatcher} found it. */
export interface RouteMatch<S> {
  readonly store: S
  /** Decoded parameter values by name; a wildcard's under `*`. */
  readonly params: Readonly<Record<string, string | undefined>>
  /** The query as sent, after `?` (or `;` under `useSemicolonDelimiter`), not decoded. `''` when there is none. */
  readonly query: string
}

/** Finds the route a request names. The engine registers every route before the first match. */
export interface RouteMatcher<S> {
  /**
   * Registers a route. `path` is written in Caffeine's route syntax, as `parseRoutePattern` reads it: a matcher for
   * another router translates it to that router's own.
   *
   * @throws ErrRouteConflict when a route of `method` already matches `path` under these constraints.
   * @throws ErrConfiguration when `path` or `method` is not one the matcher can register.
   */
  add(method: string, path: string, constraints: DerivedConstraints | undefined, store: S): void

  /**
   * `null` when no route matches.
   *
   * @throws ErrHTTPBadRequest for a path that cannot be decoded.
   */
  match(method: string, path: string, constraints: DerivedConstraints | undefined): RouteMatch<S> | null
}

/**
 * Builds the matcher of one server from its router flags and its custom constraint strategies. `version` and `host`
 * are the matcher's own; a strategy of either name replaces it.
 */
export type RouteMatcherFactory = <S>(
  flags: RouterFlags,
  strategies: readonly ConstraintStrategy<unknown>[],
) => RouteMatcher<S>

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
