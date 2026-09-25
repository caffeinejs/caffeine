import type { FeatureConfigurer } from '@caffeinejs/std'

import type { HTTPFeature } from '../feature.js'
import { HealthBuilder } from './builder.js'

/** Authors {@link HealthOptions} through {@link HealthBuilder} instead of a plain object. */
export type HealthConfigurer<C = unknown> = FeatureConfigurer<HealthBuilder<C>, C>

/**
 * The Kubernetes probes (`/livez`, `/readyz`, `/startupz`), and the budgets of the application's
 * `ApplicationHealth` they answer from: `.with(health())`.
 *
 * Installing it is the opt-in for the routes — on by default from there, unless `.k8s()` gates that default on
 * `KUBERNETES_SERVICE_HOST`, or `.enabled(false)` / a configured `enabled` turns them off outright. The budgets
 * apply either way, to every caller: `ApplicationHealth` exists in every application, and one that never installs
 * this runs it on its defaults.
 *
 * A feature rather than a plugin factory because it binds those budgets, which only `configure` can — before the
 * container initializes, and so before anything can hold the service.
 *
 * Graceful shutdown — the drain sequence and the signal handlers — is a separate concern, configured with
 * `app.shutdown(...)`.
 */
export function health<C = unknown>(configure?: HealthConfigurer<C>): HTTPFeature<C> {
  return new HealthBuilder<C>(configure as never)
}
