import { channel, tracingChannel, type TracingChannel } from 'node:diagnostics_channel'

import type { Logger } from '../logger/logger.js'
import type { SchemaIssue } from '../schema/schema.js'
import { REDACTED, isSecretPath, type SecretPaths } from './redact.js'
import type { ConfigStore } from './store.js'
import { toParts } from './tree.js'
import type { ConfigLayer, ConfigReloadOutcome, ConfigTrigger } from './types.js'

/**
 * The `node:diagnostics_channel` names a configuration store publishes on.
 *
 * `load` and `reload` are tracing channels: subscribe with `tracingChannel(name)`, and each load of one source, or
 * each reload, publishes `start`, `end`, `asyncStart` and `asyncEnd` around one message. By `asyncEnd` the message
 * carries its `result`, or the `error` a failed load threw. `change` is a plain channel, published after a swap.
 * Channels are process-wide, so every message names the `store` that published it. Read a message; never write to it.
 */
export const CONFIG_CHANNELS = {
  load: 'caffeinejs:config:load',
  reload: 'caffeinejs:config:reload',
  change: 'caffeinejs:config:change',
} as const

export interface ConfigLoadMessage {
  readonly store: ConfigStore<unknown>
  readonly source: string
  /** `start` for the first load. */
  readonly trigger: ConfigTrigger | 'start'
  readonly result?: readonly ConfigLayer[]
  readonly error?: unknown
}

export interface ConfigReloadMessage {
  readonly store: ConfigStore<unknown>
  readonly trigger: ConfigTrigger
  readonly sources: readonly string[]
  /** A reload never fails, so this is how every one ends. */
  readonly result?: ConfigReloadOutcome
}

export interface ConfigChangeMessage {
  readonly store: ConfigStore<unknown>
  readonly revision: number
  readonly changed: readonly string[]
}

export const loadChannel = tracingChannel<ConfigLoadMessage>(CONFIG_CHANNELS.load)
export const reloadChannel = tracingChannel<ConfigReloadMessage>(CONFIG_CHANNELS.reload)
const changeChannel = channel(CONFIG_CHANNELS.change)

/** Runs `fn` inside a tracing channel, or bare when nobody listens: no message is built and no wrapper runs. */
export function traced<C extends object, R>(
  tc: TracingChannel<C>,
  message: () => NoInfer<C>,
  fn: () => Promise<R>,
): Promise<R> {
  return tc.hasSubscribers ? tc.tracePromise(fn, message()) : fn()
}

export function publishChange(message: () => ConfigChangeMessage): void {
  if (changeChannel.hasSubscribers) {
    changeChannel.publish(message())
  }
}

/** How long the first load took, in milliseconds. Read by {@link logConfigLoaded}. */
export const kFirstLoadMs: unique symbol = Symbol('@caffeinejs/config:first-load-ms')

/** Rounds a duration for a log field: two decimals, because a local load takes well under a millisecond. */
export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100
}

/**
 * Writes the first load's report: `configuration loaded`, then one record per source.
 *
 * Configuration loads before the logger is configured, because the logger is configured from configuration, so the
 * store cannot write this itself. The host calls it once the logger is final.
 */
export function logConfigLoaded(logger: Logger, store: ConfigStore<unknown>): void {
  const log = logger.child({ name: 'config' })
  const inspection = store.inspect()

  log.info(
    {
      revision: inspection.revision,
      profiles: inspection.profiles,
      sources: inspection.sources.map(source => source.name),
      keys: inspection.sources.reduce((sum, source) => sum + source.keys, 0),
      ms: roundMs(store[kFirstLoadMs]),
    },
    'configuration loaded',
  )

  for (const source of inspection.sources) {
    if (source.lastError !== undefined) {
      log.warn(
        { source: source.name, err: source.lastError, consecutiveFailures: source.consecutiveFailures },
        'config source failed',
      )
    } else if (source.layers.length === 0) {
      log.debug({ source: source.name, reason: 'no layers' }, 'config source skipped')
    } else {
      log.debug(
        { source: source.name, layers: source.layers.length, keys: source.keys, ms: roundMs(source.lastLoadMs) },
        'config source loaded',
      )
    }
  }
}

/**
 * The events a running store logs, one method per event, with fixed messages and field names. Values are never
 * logged, only paths.
 *
 * The logger is read on every event rather than captured, so a logger replaced after start-up is followed.
 */
export class ConfigEvents {
  readonly #logger: () => Logger
  #parent: Logger | undefined
  #log: Logger | undefined

  constructor(logger: () => Logger) {
    this.#logger = logger
  }

  sourcePolling(source: string, intervalMs: number): void {
    this.#current().debug({ source, intervalMs }, 'config source polling')
  }

  sourceWatching(source: string): void {
    this.#current().debug({ source }, 'config source watching')
  }

  reloaded(fields: {
    revision: number
    trigger: ConfigTrigger
    sources: readonly string[]
    changed: readonly string[]
    ms: number
  }): void {
    this.#current().info(
      {
        revision: fields.revision,
        trigger: fields.trigger,
        sources: fields.sources,
        changed: fields.changed.slice(0, 20),
        changedCount: fields.changed.length,
        ms: roundMs(fields.ms),
      },
      'configuration reloaded',
    )
  }

  unchanged(fields: { trigger: ConfigTrigger; sources: readonly string[]; ms: number }): void {
    this.#current().debug(
      { trigger: fields.trigger, sources: fields.sources, ms: roundMs(fields.ms) },
      'configuration unchanged',
    )
  }

  /** A foreign validator may echo the value it rejected, so an issue under a secret path loses its message. */
  rejected(fields: {
    trigger: ConfigTrigger
    sources: readonly string[]
    issues: readonly SchemaIssue[]
    revision: number
    secrets: SecretPaths
  }): void {
    this.#current().error(
      {
        trigger: fields.trigger,
        sources: fields.sources,
        issues: fields.issues.map(issue => ({
          path: issue.path,
          message: isSecretPath(toParts(issue.path), fields.secrets) ? REDACTED : issue.message,
        })),
        revision: fields.revision,
      },
      'configuration reload rejected',
    )
  }

  sourceFailed(fields: { source: string; err: unknown; consecutiveFailures: number; nextAttemptMs?: number }): void {
    this.#current().warn(fields, 'config source failed')
  }

  sourceRecovered(source: string, failures: number): void {
    this.#current().info({ source, failures }, 'config source recovered')
  }

  listenerFailed(err: unknown): void {
    this.#current().error({ err }, 'config change listener failed')
  }

  viewFailed(err: unknown): void {
    this.#current().error({ err }, 'config view failed')
  }

  keyIgnored(source: string, layer: string, path: string): void {
    this.#current().warn({ source, layer, path }, 'config key ignored')
  }

  closed(): void {
    this.#current().debug('configuration closed')
  }

  #current(): Logger {
    const parent = this.#logger()
    if (parent !== this.#parent || this.#log === undefined) {
      this.#parent = parent
      this.#log = parent.child({ name: 'config' })
    }
    return this.#log
  }
}
