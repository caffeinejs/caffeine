import { VERSION_CONSTRAINT } from '../constraints/registry.js'
import type { AnyRouteExtension } from '../routing/programmatic/extension.js'
import { Constraint, constraint } from './constraint.js'

/**
 * Route/group extension binding routes to an API version. One implementation behind {@link Version} and
 * `Router.version()` / `RouteChain.version()`.
 */
export function version(version: string): AnyRouteExtension {
  return constraint(VERSION_CONSTRAINT, version)
}

/**
 * Binds the route — or every route of the group, on a class — to an API version selected by the `Accept-Version`
 * request header.
 *
 * `version` is a semver string, e.g. `'1.0.0'`; a request matches it with `Accept-Version: 1`, `1.x` or
 * `1.0.0`, and when several versions satisfy the header the highest wins. A request that sends no
 * `Accept-Version` does not match a versioned route.
 *
 * Sugar for `@Constraint('version', v)`. URI versioning is a separate concern — use `@Prefix('/v1')`.
 */
export function Version(v: string) {
  return Constraint(VERSION_CONSTRAINT, v)
}
