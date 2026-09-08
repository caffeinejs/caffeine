import { token } from '@caffeinejs/di'

import { type Duration, parseDuration } from '../duration/index.js'
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
 * would install its own handlers, and a suite running them concurrently exhausts the listener budget.
 */
export function isTestEnvironment(env: EnvLike = hostEnv()): boolean {
  return env.NODE_ENV === 'test' || env.VITEST !== undefined
}

/**
 * Normalizes a {@link Duration} to milliseconds.
 *
 * {@link parseDuration} returns **seconds** for a string and passes a number through untouched, so its output can
 * never reach a timer directly. A number here is already milliseconds.
 */
export function toMillis(value: Duration): number {
  return typeof value === 'number' ? value : Math.round(parseDuration(value) * 1000)
}

/**
 * Where the feature that owns the drain publishes its policy — health, in an HTTP application.
 *
 * The application reads it once the container has initialized and shuts down on what it says, which is how a
 * feature configures the drain without the application knowing which feature that is. Nothing bound, and the
 * builder's own policy applies; nothing there either, and {@link defaultShutdownOptions} does.
 */
export const kShutdownPolicy = token<ShutdownOptions>(Symbol('caffeine.shutdown.policy'))

/** The resolved, millisecond-normalized shutdown policy. */
export interface ShutdownOptions {
  /**
   * How long to keep running normally after availability starts refusing, before anything is torn down. Covers an
   * orchestrator's routing-table propagation lag: traffic is still arriving during this window and must be served,
   * not rejected.
   */
  drainDelayMs: number
  /** The budget for in-flight work to finish once teardown starts. */
  shutdownTimeoutMs: number
  /** The signals that trigger a graceful shutdown, or `false` to install none. */
  signals: readonly ShutdownSignal[] | false
  dispatcher: SignalDispatcher
}

/** The authoring shape: durations may be written as `'5s'` or as a number of milliseconds. */
export interface ShutdownConfig {
  drainDelay?: Duration
  shutdownTimeout?: Duration
  signals?: readonly ShutdownSignal[] | false
  dispatcher?: SignalDispatcher
}

/**
 * The policy an application gets with no configuration.
 *
 * `drainDelayMs` is the only environment-dependent default: outside an orchestrator there is no routing table to
 * propagate, so waiting would only slow local restarts down.
 */
export function defaultShutdownOptions(env: EnvLike = hostEnv()): ShutdownOptions {
  return {
    drainDelayMs: isKubernetes(env) ? 5_000 : 0,
    shutdownTimeoutMs: 25_000,
    signals: isTestEnvironment(env) ? false : ['SIGTERM', 'SIGINT'],
    dispatcher: detectSignalDispatcher(),
  }
}

/** Folds an authoring {@link ShutdownConfig} over {@link defaultShutdownOptions}. */
export function resolveShutdownOptions(config: ShutdownConfig = {}, env: EnvLike = hostEnv()): ShutdownOptions {
  const defaults = defaultShutdownOptions(env)

  return {
    drainDelayMs: config.drainDelay === undefined ? defaults.drainDelayMs : toMillis(config.drainDelay),
    shutdownTimeoutMs:
      config.shutdownTimeout === undefined ? defaults.shutdownTimeoutMs : toMillis(config.shutdownTimeout),
    signals: config.signals ?? defaults.signals,
    dispatcher: config.dispatcher ?? defaults.dispatcher,
  }
}
