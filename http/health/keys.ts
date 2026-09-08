import { featureConfigKey } from '@caffeinejs/std/config'

import type { HealthOptions } from './options.js'

/**
 * The resolved {@link HealthOptions}. Every HTTP application registers the health feature, so the key always
 * answers — an application that configured nothing resolves to a disabled configuration rather than an absent
 * one.
 */
export const kHealthConfig = featureConfigKey<HealthOptions>('http:health')

/**
 * Fastify route-config marker set on the probe routes. The adapter's server-level `onRequest` hook reads it to
 * skip building a request context for a probe, which no handler down that path ever uses.
 */
export const kHealthRoute = Symbol.for('@caffeinejs/http:health.route')
