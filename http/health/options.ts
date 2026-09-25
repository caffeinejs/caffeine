import { type Duration, toMillis } from '@caffeinejs/std/duration'
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

/** The resolved, millisecond-normalized health configuration. Snapshotted once at `ready()`. */
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
 * The configuration `.health()` produces with no calls on the builder.
 *
 * `enabled` is the only environment-dependent default: outside an orchestrator there is nothing polling the
 * probes, so mounting them by default would only widen the surface for nothing.
 */
export function defaultHealthOptions(env: EnvLike = hostEnv()): HealthOptions {
  return {
    enabled: isKubernetes(env),
    paths: { ...DEFAULT_HEALTH_PATHS },
    indicatorTimeoutMs: 2_000,
    probeDeadlineMs: 3_000,
    cacheTTLMs: 1_000,
    verbose: false,
    exclude: false,
  }
}

/** The health slice of the configuration tree. Every duration accepts `'5s'`-style strings or milliseconds. */
export interface HealthConfig {
  enabled?: boolean
  paths?: Partial<HealthPaths>
  indicatorTimeout?: Duration
  probeDeadline?: Duration
  cacheTTL?: Duration
  verbose?: boolean
  exclude?: boolean
}

const duration = (): ReturnType<typeof $t.Union> => $t.Union([$t.String(), $t.Number()])

/**
 * The schema governing the health slice.
 *
 * Every member is optional, and nothing is defaulted here: the resolved defaults are environment-dependent
 * (`isKubernetes`) and are applied by {@link mergeHealthConfig} afterwards. So the tree carries only what
 * somebody actually set — in code, in a file, in the environment or on the command line — and absence keeps its
 * meaning instead of being overwritten by a default written into a low band.
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
  indicatorTimeout: $t.Optional(duration()),
  probeDeadline: $t.Optional(duration()),
  cacheTTL: $t.Optional(duration()),
  verbose: $t.Optional($t.Boolean()),
  exclude: $t.Optional($t.Boolean()),
})

/**
 * Folds a resolved health slice onto the defaults, producing the millisecond-normalized options.
 *
 * `enabledDefault` is how "was `.health()` called at all" reaches this: reaching the builder is an explicit
 * opt-in that turns the probes on, while an application that never called it falls back to the Kubernetes
 * auto-detection. Either way an explicit `enabled` in the configuration wins, so `HEALTH__ENABLED=false`
 * switches the probes off without touching code.
 */
export function mergeHealthConfig(config: HealthConfig, options: { enabledDefault?: boolean } = {}): HealthOptions {
  const defaults = defaultHealthOptions()

  return {
    enabled: config.enabled ?? options.enabledDefault ?? defaults.enabled,
    paths: { ...defaults.paths, ...config.paths },
    indicatorTimeoutMs: pick(config.indicatorTimeout, defaults.indicatorTimeoutMs),
    probeDeadlineMs: pick(config.probeDeadline, defaults.probeDeadlineMs),
    cacheTTLMs: pick(config.cacheTTL, defaults.cacheTTLMs),
    verbose: config.verbose ?? defaults.verbose,
    exclude: config.exclude ?? defaults.exclude,
  }
}

function pick(value: Duration | undefined, fallback: number): number {
  return value === undefined ? fallback : toMillis(value)
}
