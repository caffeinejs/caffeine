import { contributionKey } from '@caffeinejs/std'

import type { HealthOptions } from './options.js'

/**
 * The resolved {@link HealthOptions}. Contributed by the health builder when the application configured one and
 * by the health service configurer otherwise, so it is always present — the feature resolves to a disabled
 * configuration rather than an absent one.
 */
export const kHealthContribution = contributionKey<HealthOptions>('http:health.options')

/**
 * Fastify route-config marker set on the probe routes. The adapter's server-level `onRequest` hook reads it to
 * skip building a request context for a probe, which no handler down that path ever uses.
 */
export const kHealthRoute = Symbol.for('@caffeinejs/http:health.route')
