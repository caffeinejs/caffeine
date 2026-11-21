import type { RouteOptions } from '../routing/options.js'

/** The one value that marks a route: configuration data and an application's own object cannot produce it. */
const ACCESS_CONTROL_EXEMPT: unique symbol = Symbol('caffeine.http.access-control-exempt')

declare module '../routing/options.js' {
  interface RouteOptions {
    /** Marks a route the framework serves on the application's behalf, outside its access control. */
    accessControlExempt?: typeof ACCESS_CONTROL_EXEMPT
  }
}

/** Whether a route's options carry the framework's access-control mark. */
export function isAccessControlExempt(options: Readonly<Partial<RouteOptions>>): boolean {
  return options.accessControlExempt === ACCESS_CONTROL_EXEMPT
}

/**
 * Puts a route, or every route of a group, outside the application's access control: no authentication gate, no
 * global guard, no authorization, whatever a group above it declares. What the framework serves on the application's
 * behalf carries it: the health probes, the OIDC routes, a static mount marked `anonymous`. Inventories report the
 * route `skipped`.
 *
 * @throws ErrConfiguration at start-up for a route that declares `authorize(...)` itself.
 */
export function accessControlExempt(): Partial<RouteOptions> {
  return { accessControlExempt: ACCESS_CONTROL_EXEMPT }
}
