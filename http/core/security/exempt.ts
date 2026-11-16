import type { AnyRouteExtension } from '../routing/extension.js'

/**
 * The route config key of a route the framework serves on the application's behalf, outside its access control: no
 * authentication gate, no global guard, no authorization. Set by the health probes.
 */
export const kAccessControlExempt = 'caffeine:access-control-exempt'

/** The one value that marks a route: an application's `.config(...)` or `@Config(...)` cannot produce it. */
export const ACCESS_CONTROL_EXEMPT: unique symbol = Symbol('caffeine.http.access-control-exempt')

/** Whether a route's config carries the framework's access-control mark. */
export function isAccessControlExempt(config: ReadonlyMap<string, unknown>): boolean {
  return config.get(kAccessControlExempt) === ACCESS_CONTROL_EXEMPT
}

/**
 * Puts a route, or every route of a group, outside the application's access control: no authentication gate, no
 * global guard, no authorization, whatever a group above it declares. What the framework serves on the application's
 * behalf carries it: the health probes, the OIDC routes, a static mount marked `anonymous`. Inventories report the
 * route `skipped`.
 *
 * @throws ErrConfiguration at start-up for a route that declares `authorize(...)` itself.
 */
export function accessControlExempt(): AnyRouteExtension {
  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config(kAccessControlExempt, ACCESS_CONTROL_EXEMPT)
  }
}
