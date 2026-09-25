import { type Duration, toMillis } from '@caffeinejs/std/duration'
import { defaultHealthRegistryOptions } from '@caffeinejs/std/health'
import { $t } from '@caffeinejs/std/schema'
import { isKubernetes } from '@caffeinejs/std/shutdown'

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

/** The resolved, millisecond-normalized health configuration. Resolved once, when `health()` configures. */
export interface HealthOptions {
  /** Whether the probe routes are mounted at all. */
  enabled: boolean
  paths: HealthPaths
  /** Per-indicator budget. An indicator exceeding it is aborted and reported `down`. */
  indicatorTimeoutMs: number
  /** Whole-probe budget. Bounds the response time regardless of how many indicators are registered. */
  probeDeadlineMs: number
  /** How long an evaluation is reused. Bounds the load probes place on the dependencies they check. */
  cacheTTLMs: number
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
 * bare number is refused, because its unit would be ambiguous. An object handed to `config(...)` from code may give
 * milliseconds instead.
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
 * The schema governing the health slice.
 *
 * Every member is optional, and nothing is defaulted here: the resolved defaults are environment-dependent
 * (`isKubernetes`) and are applied by {@link mergeHealthConfig} afterwards. So the tree carries only what
 * somebody actually set — in code, in a file, in the environment or on the command line — and absence keeps its
 * meaning instead of being overwritten by a default written into a low band.
 *
 * The budgets are `$t.Duration()`: `HEALTH__INDICATOR_TIMEOUT=5000` or `'5 hours'` fails validation at `ready()`
 * rather than reaching a timer as 0.
 */
export const healthConfigSchema = $t.Object({
  enabled: $t.Optional($t.Boolean()),
  paths: $t.Optional(
    $t.Object({
      live: $t.Optional($t.String()),
      ready: $t.Optional($t.String()),
      startup: $t.Optional($t.String()),
    }),
  ),
  indicatorTimeout: $t.Optional($t.Duration()),
  probeDeadline: $t.Optional($t.Duration()),
  cacheTtl: $t.Optional($t.Duration()),
  verbose: $t.Optional($t.Boolean()),
  exclude: $t.Optional($t.Boolean()),
})

/**
 * Folds a resolved health slice onto the defaults, producing the millisecond-normalized options.
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
    indicatorTimeoutMs: pick(config.indicatorTimeout, defaults.indicatorTimeoutMs),
    probeDeadlineMs: pick(config.probeDeadline, defaults.probeDeadlineMs),
    cacheTTLMs: pick(config.cacheTtl, defaults.cacheTTLMs),
    verbose: config.verbose ?? defaults.verbose,
    exclude: config.exclude ?? defaults.exclude,
  }
}

function pick(value: Duration | undefined, fallback: number): number {
  return value === undefined ? fallback : toMillis(value)
}
