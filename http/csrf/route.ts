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
 * The programmatic form of `@CSRFExempt()`: `router.with(csrfExempt())`, or `router.post('/hook').with(csrfExempt())`.
 */
export function csrfExempt(exempt = true): AnyRouteExtension {
  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config(kCSRFRoute, { exempt } satisfies CSRFRouteConfig)
  }
}

/**
 * Route config for a route registered straight on the server that cross-origin protection must leave alone.
 *
 * A fresh object every call: Fastify hands a GET route's automatic HEAD twin the very same config object.
 *
 * @example
 * ```ts
 * instance.post('/hook', { config: csrfExemptConfig() }, handler)
 * ```
 */
export function csrfExemptConfig(): { [kCSRFRoute]: CSRFRouteConfig } {
  return { [kCSRFRoute]: { exempt: true } }
}

/** What a route's config says of the check: `true` exempt, `false` protected, `undefined` when it says nothing. */
export function csrfMarkOf(config: unknown): boolean | undefined {
  return (config as Record<string, CSRFRouteConfig | undefined> | undefined)?.[kCSRFRoute]?.exempt
}
