import { token } from '@caffeinejs/di'

import type { HealthOptions } from './options.js'

/**
 * The resolved {@link HealthOptions}. Every HTTP application registers the health feature, so the key always
 * answers — an application that configured nothing resolves to a disabled configuration rather than an absent
 * one.
 */
export const kHealthOptions = token<HealthOptions>(Symbol('caffeine.http.health.options'))

/**
 * Fastify route-config marker set on the probe routes. The adapter's server-level `onRequest` hook reads it to
 * skip building a request context for a probe, which no handler down that path ever uses.
 */
export const kHealthRoute = Symbol.for('@caffeinejs/http:health.route')
