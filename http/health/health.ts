import type { Feature, FeatureConfigurer } from '@caffeinejs/std'

import { HealthBuilder } from './builder.js'

/** Authors the health budgets through {@link HealthBuilder} instead of a plain object. */
export type HealthConfigurer<C = unknown> = FeatureConfigurer<HealthBuilder<C>, C>

/**
 * The health feature: the budgets of the application's `ApplicationHealth` — per-indicator timeout,
 * whole-probe deadline, cache TTL — bound while the container is open.
 *
 * The budgets govern every caller: `ApplicationHealth` exists in every application, and one that never
 * installs this runs it on its defaults. The Kubernetes probe routes are separate — `.with(healthProbes())`
 * mounts them, with or without this feature installed — so an application polled by something other than
 * HTTP, Watt say, installs only this.
 *
 * A feature rather than a plugin factory because it binds those budgets, which only `configure` can — before
 * the container initializes, and so before anything can hold the service.
 *
 * Graceful shutdown — the drain sequence and the signal handlers — is a separate concern, configured with
 * `app.shutdown(...)`.
 */
export function Health<C = unknown>(configure?: HealthConfigurer<C>): Feature<C> {
  return new HealthBuilder<C>(configure as never)
}
