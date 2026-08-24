import {
  type SignalDispatcher,
  type ShutdownSignal,
  detectSignalDispatcher,
  isKubernetes,
  isTestEnvironment,
} from '@caffeinejs/std'
import { solutions } from '../error/util.js'
import { ErrHealthConfiguration } from './errors.js'

/**
 * Optional downward-API variable carrying `spec.terminationGracePeriodSeconds`. The value is not otherwise
 * readable from inside a pod, so without it the boot-time budget check assumes the Kubernetes default.
 */
export const GRACE_PERIOD_ENV_VAR = 'TERMINATION_GRACE_PERIOD_SECONDS'

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
  /**
   * How long to keep serving normally after readiness starts refusing, before the server is closed. Covers the
   * orchestrator's EndpointSlice propagation lag — traffic is still arriving during this window and must be
   * answered, not rejected.
   */
  drainDelayMs: number
  /** The budget for in-flight requests to finish once the server is closing. Sockets are forced shut after it. */
  shutdownTimeoutMs: number
  /**
   * The pod's `terminationGracePeriodSeconds`. Used only to validate the drain budget at boot; it cannot be read
   * from inside the pod, so it is either configured or left at the Kubernetes default.
   */
  terminationGracePeriodMs: number
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
  /** The signals that trigger a graceful shutdown, or `false` to install none. */
  signals: readonly ShutdownSignal[] | false
  /** Delivers signals and diagnostics. Defaults to the host runtime's; an adapter may supply its own. */
  dispatcher: SignalDispatcher
}

export const DEFAULT_HEALTH_PATHS: HealthPaths = {
  live: '/livez',
  ready: '/readyz',
  startup: '/startupz',
}

/**
 * The configuration `.health()` produces with no calls on the builder.
 *
 * `drainDelayMs` is the only environment-dependent default: outside an orchestrator there is no routing table to
 * propagate, so waiting would only slow local restarts down.
 */
export function defaultHealthOptions(env: EnvLike = hostEnv()): HealthOptions {
  return {
    enabled: isKubernetes(env),
    paths: { ...DEFAULT_HEALTH_PATHS },
    drainDelayMs: isKubernetes(env) ? 5_000 : 0,
    shutdownTimeoutMs: 25_000,
    terminationGracePeriodMs: gracePeriodOf(env),
    indicatorTimeoutMs: 2_000,
    probeDeadlineMs: 3_000,
    cacheTTLMs: 1_000,
    verbose: false,
    exclude: false,
    signals: isTestEnvironment(env) ? false : ['SIGTERM', 'SIGINT'],
    dispatcher: detectSignalDispatcher(),
  }
}

// The Kubernetes default, used whenever the pod does not publish its own value.
const DEFAULT_GRACE_PERIOD_MS = 30_000

function gracePeriodOf(env: EnvLike): number {
  const seconds = Number(env[GRACE_PERIOD_ENV_VAR])

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_GRACE_PERIOD_MS
}

/** Margin left between the end of the drain budget and the orchestrator's `SIGKILL`. */
const GRACE_MARGIN_MS = 2_000

/** The outcome of validating a resolved configuration: the corrected options plus anything worth saying aloud. */
export interface HealthValidation {
  options: HealthOptions
  warnings: readonly string[]
}

/**
 * Checks the shutdown budget against the pod's termination grace period, at `ready()` — while the logs are still
 * being watched, rather than during the shutdown the mistake would ruin.
 *
 * `drainDelayMs + shutdownTimeoutMs` must fit inside `terminationGracePeriodMs`, otherwise `SIGKILL` arrives
 * mid-drain and the in-flight requests the budget was protecting are dropped anyway. An overrun is clamped rather
 * than rejected; only a grace period that cannot fit the drain delay at all is fatal.
 */
export function validateHealthOptions(options: HealthOptions, env: EnvLike = hostEnv()): HealthValidation {
  const warnings: string[] = []
  const budget = options.drainDelayMs + options.shutdownTimeoutMs

  if (budget + GRACE_MARGIN_MS > options.terminationGracePeriodMs) {
    const clamped = options.terminationGracePeriodMs - options.drainDelayMs - GRACE_MARGIN_MS

    if (clamped <= 0) {
      throw new ErrHealthConfiguration(
        `Cannot configure health: a drain delay of ${options.drainDelayMs}ms does not fit in a termination grace period of ${options.terminationGracePeriodMs}ms`
        + solutions(
          'Lower the drain delay with .drainDelay(...)',
          'Raise terminationGracePeriodSeconds on the pod spec and mirror it with .terminationGracePeriod(...)',
        ),
      )
    }

    warnings.push(
      `Health shutdown budget (${budget}ms) exceeds the termination grace period (${options.terminationGracePeriodMs}ms); `
      + `the shutdown timeout was clamped to ${clamped}ms so in-flight requests are not cut short by SIGKILL`,
    )

    options = { ...options, shutdownTimeoutMs: clamped }
  }

  if (options.enabled && options.drainDelayMs === 0 && isKubernetes(env)) {
    warnings.push(
      'Health drain delay is 0 under Kubernetes: the server will stop accepting before the EndpointSlice update '
      + 'propagates, dropping in-flight requests on every rolling deploy',
    )
  }

  return { options, warnings }
}

/** Emits the validation warnings through the dispatcher, so they are capturable rather than console noise. */
export function emitHealthWarnings(
  warnings: readonly string[],
  dispatcher: SignalDispatcher = detectSignalDispatcher(),
): void {
  for (const warning of warnings) {
    dispatcher.warn(warning)
  }
}
