import { token } from '@caffeinejs/di'
import type { HealthOptions } from './options.js'

/**
 * DI key for the resolved {@link HealthOptions}. Bound by the health service configurer, always present once the
 * application is ready — the feature resolves to a disabled configuration rather than an absent one.
 */
export const kHealthOptions = token<HealthOptions>(Symbol.for('@caffeinejs/http:health.options'))

/**
 * Fastify route-config marker set on the probe routes. The adapter's server-level `onRequest` hook reads it to
 * skip building a request context for a probe, which no handler down that path ever uses.
 */
export const kHealthRoute = Symbol.for('@caffeinejs/http:health.route')
