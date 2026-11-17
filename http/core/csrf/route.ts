import type { AnyRouteExtension } from '../routing/extension.js'

/** The route config key the `csrf()` plugin reads, holding a {@link CSRFRouteConfig}. */
export const kCSRFRoute = 'caffeine:csrf'

export interface CSRFRouteConfig {
  exempt: boolean
}

/**
 * Leaves a route, or every route of a group, out of cross-origin protection: a webhook receiver, a form a partner's
 * site posts here. `csrfExempt(false)` puts one route of an exempt group back under it, and keeps a route protected
 * whose path is under `exclude(...)`: a route's own mark wins over a path.
 *
 * The programmatic form of `@CSRFExempt()`: `router.extend(csrfExempt())`, or `router.post('/hook').extend(csrfExempt())`.
 */
export function csrfExempt(exempt = true): AnyRouteExtension {
  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config(kCSRFRoute, { exempt } satisfies CSRFRouteConfig)
  }
}

/** What a route's config says of the check: `true` exempt, `false` protected, `undefined` when it says nothing. */
export function csrfMarkOf(config: unknown): boolean | undefined {
  return (config as Record<string, CSRFRouteConfig | undefined> | undefined)?.[kCSRFRoute]?.exempt
}
