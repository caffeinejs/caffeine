import { token } from '@caffeinejs/di'

import type { HealthRegistryOptions } from './registry.js'

/**
 * Where `health()` from `@caffeinejs/http` publishes the budgets the application's `ApplicationHealth` evaluates
 * with. Nothing bound here, the service runs on {@link defaultHealthRegistryOptions}.
 */
export const kHealthRegistryOptions = token<HealthRegistryOptions>(Symbol('caffeine.health.registry.options'))

/** The budgets an application gets when nothing configured them. */
export function defaultHealthRegistryOptions(): HealthRegistryOptions {
  return { indicatorTimeoutMs: 2_000, probeDeadlineMs: 3_000, cacheTTLMs: 1_000 }
}
