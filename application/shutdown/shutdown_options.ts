import { token } from '@caffeinejs/di'
import { type Duration, Second } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { ErrShutdownConfiguration } from './errors.js'
import { type SignalDispatcher, type ShutdownSignal, detectSignalDispatcher } from './signals.js'

/** The environment variable the kubelet injects into every pod. Presence of it means "running under Kubernetes". */
export const KUBERNETES_ENV_VAR = 'KUBERNETES_SERVICE_HOST'

interface EnvLike {
  [key: string]: string | undefined
}

function hostEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {}
}

/** Whether the process is running inside a Kubernetes pod. */
export function isKubernetes(env: EnvLike = hostEnv()): boolean {
  return (env[KUBERNETES_ENV_VAR] ?? '') !== ''
}

/**
 * Whether a test runner is driving the process. Signal handling is skipped there: every application under test
 * would install its own handlers, and a suite running them concurrently exhausts the listener budget. This is
 * runtime detection in the class of {@link detectSignalDispatcher}, not configuration — it reads `NODE_ENV` and
 * `VITEST`, never `SHUTDOWN__*`, and an explicit `signals` value still wins.
 */
export function isTestEnvironment(env: EnvLike = hostEnv()): boolean {
  return env.NODE_ENV === 'test' || env.VITEST !== undefined
}

/**
 * Where the shutdown feature publishes its resolved policy.
 *
 * The application reads it once the container has initialized and shuts down on what it says. The feature is
 * registered unconditionally and binds this when it configures, so {@link defaultShutdownOptions} applies only to a
 * shutdown that starts before the platform finished setting up.
 */
export const kShutdownPolicy = token<ShutdownOptions>(Symbol('caffeine.shutdown.policy'))

/** The resolved shutdown policy. */
export interface ShutdownOptions {
  /**
   * How long to keep running normally after availability starts refusing, before anything is torn down. Covers an
   * orchestrator's routing-table propagation lag: traffic is still arriving during this window and must be served,
   * not rejected.
   */
  drainDelay: Duration
  /**
   * The budget for in-flight work to finish once teardown starts.
   *
   * Defaults to whatever {@link terminationGracePeriod} has left after the drain delay, so only a value
   * somebody configured can overrun it.
   */
  shutdownTimeout: Duration
  /**
   * The pod's `terminationGracePeriodSeconds`. Used only to validate the drain budget at boot; it cannot be read
   * from inside the pod, so it is either configured or left at the Kubernetes default.
   */
  terminationGracePeriod: Duration
  /** The signals that trigger a graceful shutdown, or `false` to install none. */
  signals: readonly ShutdownSignal[] | false
  dispatcher: SignalDispatcher
}

/**
 * The shutdown slice of the configuration tree. There, a duration is written as text — `'5s'`, `'1h30m'` — and a
 * bare number is refused, because its unit would be ambiguous; an object handed to `config(...)` from code gives a
 * `Duration`, `5 * Second`. The dispatcher is not here — a function cannot travel a configuration tree, so it stays
 * on the builder.
 */
export interface ShutdownConfig {
  drainDelay?: Duration
  shutdownTimeout?: Duration
  terminationGracePeriod?: Duration
  signals?: readonly ShutdownSignal[] | false
}

// The Kubernetes default, used whenever the pod does not publish its own value.
const DEFAULT_GRACE_PERIOD = 30 * Second

/** Margin left between the end of the drain budget and the orchestrator's `SIGKILL`. */
const GRACE_MARGIN = 2 * Second

/** What is left of the grace period once the drain delay and the `SIGKILL` margin are taken out. */
function remainingBudget(drainDelay: Duration, terminationGracePeriod: Duration): Duration {
  return Math.max(0, terminationGracePeriod - drainDelay - GRACE_MARGIN)
}

/**
 * The policy an application gets with no configuration.
 *
 * `drainDelay` is five seconds under an orchestrator and `0` otherwise — outside a routing table there is nothing
 * to propagate, so waiting would only slow local restarts down. An explicit `.drainDelay(0)` still disables it.
 * `signals` is suppressed under a test runner (see {@link isTestEnvironment}).
 *
 * `shutdownTimeout` is whatever the grace period has left once the drain delay and the `SIGKILL` margin are
 * taken out, so the defaults fit their own budget and {@link validateShutdownOptions} has nothing to clamp.
 */
export function defaultShutdownOptions(env: EnvLike = hostEnv()): ShutdownOptions {
  const drainDelay = isKubernetes(env) ? 5 * Second : 0

  return {
    drainDelay,
    shutdownTimeout: remainingBudget(drainDelay, DEFAULT_GRACE_PERIOD),
    terminationGracePeriod: DEFAULT_GRACE_PERIOD,
    signals: isTestEnvironment(env) ? false : ['SIGTERM', 'SIGINT'],
    dispatcher: detectSignalDispatcher(),
  }
}

/**
 * Folds a resolved shutdown slice onto {@link defaultShutdownOptions}.
 *
 * The dispatcher is not part of the slice — it is a function. It arrives on the side, from the builder.
 */
export function mergeShutdownConfig(
  config: ShutdownConfig,
  options: { dispatcher?: SignalDispatcher } = {},
): ShutdownOptions {
  const defaults = defaultShutdownOptions()
  // Resolved before the timeout, which is derived from both of them when nothing configured it.
  const drainDelay = config.drainDelay ?? defaults.drainDelay
  const terminationGracePeriod = config.terminationGracePeriod ?? defaults.terminationGracePeriod

  return {
    drainDelay,
    shutdownTimeout: config.shutdownTimeout ?? remainingBudget(drainDelay, terminationGracePeriod),
    terminationGracePeriod,
    signals: config.signals ?? defaults.signals,
    dispatcher: options.dispatcher ?? defaults.dispatcher,
  }
}

/** The outcome of validating a resolved policy: the corrected options plus anything worth saying aloud. */
export interface ShutdownValidation {
  options: ShutdownOptions
  warnings: readonly string[]
}

/**
 * Checks the shutdown budget against the pod's termination grace period, at `bootstrap()` — while the logs are still
 * being watched, rather than during the shutdown the mistake would ruin.
 *
 * `drainDelay + shutdownTimeout` must fit inside `terminationGracePeriod`, otherwise `SIGKILL` arrives
 * mid-drain and the in-flight work the budget was protecting is dropped anyway. An overrun is clamped rather
 * than rejected, and the default timeout is derived from the grace period, so the warning always names a value
 * somebody set. A drain delay that does not fit the grace period on its own is fatal, whatever the timeout
 * came out as.
 *
 * Under Kubernetes a drain delay of 0 is warned about too, unless `origin.drainDelayInCode` says a fluent call set
 * it: that 0 is taken as meant, for an application nothing routes to.
 */
export function validateShutdownOptions(
  options: ShutdownOptions,
  env: EnvLike = hostEnv(),
  origin: { drainDelayInCode?: boolean } = {},
): ShutdownValidation {
  const warnings: string[] = []
  const budget = options.drainDelay + options.shutdownTimeout
  const remaining = remainingBudget(options.drainDelay, options.terminationGracePeriod)

  // Checked on the drain delay alone: a derived timeout is floored at 0, so a budget that fits says nothing
  // about a drain delay that has already eaten the whole grace period.
  if (remaining <= 0) {
    throw new ErrShutdownConfiguration(
      errMessage(
        `Cannot configure graceful shutdown: a drain delay of ${options.drainDelay}ms does not fit in a termination grace period of ${options.terminationGracePeriod}ms`,
      )
        .solutions(
          'Lower the drain delay with .drainDelay(...)',
          'Raise terminationGracePeriodSeconds on the pod spec and mirror it with .terminationGracePeriod(...)',
        )
        .reference('@caffeinejs/application', ErrShutdownConfiguration)
        .build(),
    )
  }

  if (budget + GRACE_MARGIN > options.terminationGracePeriod) {
    warnings.push(
      `Shutdown budget (${budget}ms) exceeds the termination grace period (${options.terminationGracePeriod}ms); ` +
        `the shutdown timeout was clamped to ${remaining}ms so in-flight work is not cut short by SIGKILL`,
    )

    options = { ...options, shutdownTimeout: remaining }
  }

  // A 0 written in code is a decision, and a fluent method is the last word. One from the configuration is how a
  // copied environment turns off the drain of an application a Service does route to.
  if (options.drainDelay === 0 && isKubernetes(env) && origin.drainDelayInCode !== true) {
    warnings.push(
      'Shutdown drain delay is 0 under Kubernetes, from the configuration: behind a Service, the application stops ' +
        'accepting before Kubernetes stops routing to it, so every rolling deploy drops requests. For an application ' +
        'nothing routes to, set .drainDelay(0) in code',
    )
  }

  return { options, warnings }
}

/**
 * Validates a merged policy and emits whatever the check had to say.
 *
 * The warnings go through the dispatcher rather than straight to the console, so they are capturable — under
 * Node that tags them `CaffeineShutdownWarning`.
 */
export function finalizeShutdownOptions(
  options: ShutdownOptions,
  origin: { drainDelayInCode?: boolean } = {},
): ShutdownOptions {
  const validated = validateShutdownOptions(options, hostEnv(), origin)

  for (const warning of validated.warnings) {
    options.dispatcher.warn(warning)
  }

  return validated.options
}
