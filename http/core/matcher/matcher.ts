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

/** Builds the matcher of one server from its router flags. */
export type RouteMatcherFactory = <S>(flags: RouterFlags) => RouteMatcher<S>

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
