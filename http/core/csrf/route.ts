import { RouteOptions } from '../routing/options.js'

export interface CSRFRouteConfig {
  exempt: boolean
}

declare module '../routing/options.js' {
  interface RouteOptions {
    /** Read by `csrf()`: whether this route is left out of the cross-origin check. */
    csrf?: CSRFRouteConfig
  }
}

/**
 * Leaves a route, or every route of a group, out of cross-origin protection: a webhook receiver, a form a partner's
 * site posts here. `csrfExempt(false)` puts one route of an exempt group back under it, and keeps a route protected
 * whose path is under `exclude(...)`: a route's own mark wins over a path.
 *
 * The programmatic form of `@CSRFExempt()`: `router.routeOptions(csrfExempt())`, or
 * `router.post('/hook').options(csrfExempt())`.
 */
export function csrfExempt(exempt = true): Partial<RouteOptions> {
  return { csrf: { exempt } }
}

/**
 * Leaves a route, or every route of a controller, out of cross-origin protection: a webhook receiver, a form a
 * partner's site posts here.
 *
 * On a controller it exempts every method, one added later included; on a method it decides for that method whatever
 * the controller declared. `@CSRFExempt(false)` keeps a method protected in an exempt controller, and under a path
 * `exclude(...)` leaves alone. The programmatic form is {@link csrfExempt}.
 */
export function CSRFExempt(exempt = true) {
  return RouteOptions(csrfExempt(exempt))
}
