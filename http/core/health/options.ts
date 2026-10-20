import { defaultHealthRegistryOptions } from '@caffeinejs/application/health'
import { isKubernetes } from '@caffeinejs/application/shutdown'
import type { Duration } from '@caffeinejs/std/duration'

interface EnvLike {
  [key: string]: string | undefined
}

function hostEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {}
}

/** The three probe paths. Kubernetes taxonomy, not Actuator's. */
export interface HealthPaths {
  live: string
  ready: string
  startup: string
}

/** The resolved health configuration. Resolved once, when `health()` configures. */
export interface HealthOptions {
  /** Whether the probe routes are mounted at all. */
  enabled: boolean
  paths: HealthPaths
  /** Per-indicator budget. An indicator exceeding it is aborted and reported `down`. */
  indicatorTimeout: Duration
  /** Whole-probe budget. Bounds the response time regardless of how many indicators are registered. */
  probeDeadline: Duration
  /** How long an evaluation is reused. Bounds the load probes place on the dependencies they check. */
  cacheTTL: Duration
  /** Whether `?verbose` may expand the response body. Off by default — the body names your dependencies. */
  verbose: boolean
  /** Whether `?exclude=<name>` may skip an indicator. Off by default — it lets a caller make readiness lie. */
  exclude: boolean
}

export const DEFAULT_HEALTH_PATHS: HealthPaths = {
  live: '/livez',
  ready: '/readyz',
  startup: '/startupz',
}

/**
 * What every setting falls back to. The budgets are the ones `ApplicationHealth` runs on when `health()` is not
 * installed at all.
 *
 * `enabled` is the only environment-dependent default: outside an orchestrator there is nothing polling the
 * probes, so mounting them by default would only widen the surface for nothing. `health()` passes a default of its
 * own, so this one only reaches a caller of {@link mergeHealthConfig} that names none.
 */
export function defaultHealthOptions(env: EnvLike = hostEnv()): HealthOptions {
  return {
    enabled: isKubernetes(env),
    paths: { ...DEFAULT_HEALTH_PATHS },
    ...defaultHealthRegistryOptions(),
    verbose: false,
    exclude: false,
  }
}

/**
 * The health slice of the configuration tree. There, a duration is written as text — `'5s'`, `'1h30m'` — and a
 * bare number such as `'5000'` is refused; an object handed to `config(...)` from code gives a
 * `Duration`, `5 * Second`.
 *
 * Every key is spelled the way its environment variable folds, so `HEALTH__CACHE_TTL` sets `cacheTtl`: that is
 * the key the builder's `cacheTTL(...)` stands for.
 */
export interface HealthConfig {
  enabled?: boolean
  paths?: Partial<HealthPaths>
  indicatorTimeout?: Duration
  probeDeadline?: Duration
  cacheTtl?: Duration
  verbose?: boolean
  exclude?: boolean
}

/**
 * Folds a resolved health slice onto the defaults.
 *
 * `enabledDefault` is what the builder decides `enabled` falls back to: on once `health()` is installed, or the
 * Kubernetes auto-detection after `.k8s()`. An explicit `enabled` wins over both, so with the block wired through
 * `h.config(...)`, `HEALTH__ENABLED=false` switches the probes off without touching code.
 */
export function mergeHealthConfig(config: HealthConfig, options: { enabledDefault?: boolean } = {}): HealthOptions {
  const defaults = defaultHealthOptions()

  return {
    enabled: config.enabled ?? options.enabledDefault ?? defaults.enabled,
    paths: { ...defaults.paths, ...config.paths },
    indicatorTimeout: config.indicatorTimeout ?? defaults.indicatorTimeout,
    probeDeadline: config.probeDeadline ?? defaults.probeDeadline,
    cacheTTL: config.cacheTtl ?? defaults.cacheTTL,
    verbose: config.verbose ?? defaults.verbose,
    exclude: config.exclude ?? defaults.exclude,
  }
}
