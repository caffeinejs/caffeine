import type { EventEmitter } from 'node:events'

import { DeferredCtor, Scopes, type ContainerOps, type InjectionToken } from '@caffeinejs/di'
import { FeatureBuilder, kFeatureName, toMillis, type Duration, type FeatureConfigureKit } from '@caffeinejs/std'
import { logToken, newNoopLogger, type Logger } from '@caffeinejs/std/logger'

import type { Backend } from './backend.js'
import type { DistLockConfigSlice } from './config.js'
import { CaffeineDistLock } from './distlock.js'
import { ErrDistLockConfiguration } from './errors.js'
import { kDistLock } from './keys.js'
import type { LockEventMap } from './observability/channels.js'
import { DEFAULT_DIST_LOCK_OPTIONS, type DistLockOptions } from './options.js'

type Listener = (...args: unknown[]) => void

/**
 * Fluent configuration for the distributed lock service.
 *
 * The backend is the one thing with no default: pick it, and the rest of the settings only tune how long a
 * lease lasts and how hard `acquire` tries. Everything set here is final — configuration reaches the feature
 * because the application's callback wired it through {@link config}, and a setter written in code beats
 * whatever the tree carries.
 */
export class DistLockBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'distlock'

  #backend: Backend | InjectionToken<Backend> | undefined
  #config: Partial<DistLockConfigSlice> | undefined
  #ttl: Duration | undefined
  #wait: Duration | undefined
  #retryDelay: Duration | undefined
  #retryJitter: number | undefined
  #logger: Logger | false | undefined
  readonly #listeners: Array<[event: keyof LockEventMap, listener: Listener]> = []

  /**
   * The backend every lock runs on, as an instance or as a key to resolve it from the container.
   *
   * There is no default. A lock service that silently fell back to a single-process backend would hand a
   * fleet the one answer it must never give.
   */
  backend(backend: Backend | InjectionToken<Backend>): this {
    this.#backend = backend
    return this
  }

  /** How long a lease lasts when a call does not say. Also the default `once` window. */
  ttl(ttl: Duration): this {
    this.#ttl = ttl
    return this
  }

  /** How long `acquire` keeps retrying when a call does not say. */
  wait(wait: Duration): this {
    this.#wait = wait
    return this
  }

  /** The pause between two acquisition attempts, before jitter. */
  retryDelay(delay: Duration): this {
    this.#retryDelay = delay
    return this
  }

  /** The fraction of the retry delay added at random to each pause, between `0` and `1`. */
  retryJitter(fraction: number): this {
    this.#retryJitter = fraction
    return this
  }

  /**
   * The logger the lock service writes its own records to, or `false` to write none.
   *
   * Left unset, it is the application logger's child named `distlock`. The records are one per lock operation:
   * routine ones at `debug` (`trace` for an attempt that found the key held), and one `warn` per incident — a
   * timed-out acquisition, a lease found taken, a backend failure, a lease that lapsed before its release.
   */
  logger(logger: Logger | false): this {
    this.#logger = logger
    return this
  }

  /**
   * Adds a listener to the lock service's {@link CaffeineDistLock.events} as soon as the service exists — before
   * any lock is taken, including one taken while another binding bootstraps.
   *
   * Each call adds one more; nothing is replaced.
   */
  on<E extends keyof LockEventMap>(event: E, listener: (...args: LockEventMap[E]) => void): this {
    this.#listeners.push([event, listener as Listener])
    return this
  }

  /**
   * Reads the settings from a node of the configuration tree, e.g. `c.app.distlock`.
   *
   * The node is read once, when the feature configures. Every other method on this builder wins over what it
   * carries.
   */
  config(config: Partial<DistLockConfigSlice>): this {
    this.#config = config
    return this
  }

  protected configure(kit: FeatureConfigureKit<C>): void {
    const backend = this.#backend
    if (backend === undefined) {
      throw new ErrDistLockConfiguration(
        'Cannot install distributed locking without a backend' +
          '\n  - Pass one explicitly, for example .backend(new MemoryLockBackend()) from @caffeinejs/distlock/backend/memory' +
          '\n  - Or bind your own and pass its key, for example .backend(kDistLockBackend)',
      )
    }

    const options: DistLockOptions = {
      ttlMs: msOf(this.#ttl ?? this.#config?.ttl) ?? DEFAULT_DIST_LOCK_OPTIONS.ttlMs,
      waitMs: msOf(this.#wait ?? this.#config?.wait) ?? DEFAULT_DIST_LOCK_OPTIONS.waitMs,
      retryDelayMs: msOf(this.#retryDelay ?? this.#config?.retryDelay) ?? DEFAULT_DIST_LOCK_OPTIONS.retryDelayMs,
      retryJitter: this.#retryJitter ?? this.#config?.retryJitter ?? DEFAULT_DIST_LOCK_OPTIONS.retryJitter,
    }

    // The schema bounds what the tree may carry; the fluent setter has nothing in front of it.
    if (!(options.retryJitter >= 0 && options.retryJitter <= 1)) {
      throw new ErrDistLockConfiguration(
        `Cannot install distributed locking: retry jitter "${options.retryJitter}" is outside 0..1` +
          '\n  - Pass a fraction of the retry delay, for example .retryJitter(0.5)',
      )
    }

    const logger = this.#logger
    const listeners = [...this.#listeners]

    // Keyed by the class, named by the token: the container reads `onDestroy` off a binding's constructor, and
    // a factory bound under a plain symbol has none to read, so renewal timers would outlive disposal. The
    // name is what user code resolves, since `DistLock` is an interface.
    kit.container.bind(CaffeineDistLock, t =>
      t
        .toFactory(ctx => {
          const service = new CaffeineDistLock(
            resolveBackend(backend, ctx.container),
            options,
            resolveLogger(logger, ctx.container),
          )

          for (const [event, listener] of listeners) {
            ;(service.events as EventEmitter).on(event, listener)
          }

          return service
        })
        .names(kDistLock)
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )
  }
}

function msOf(value: Duration | undefined): number | undefined {
  return value === undefined ? undefined : toMillis(value)
}

// Resolved inside the factory, at `init()`, so it reads the logger `.logger(...)` on the application settled on
// during `ready()` rather than the one it started with.
function resolveLogger(logger: Logger | false | undefined, container: ContainerOps): Logger {
  if (logger === false) {
    return newNoopLogger()
  }

  return logger ?? container.get(logToken()).child({ name: 'distlock' })
}

function resolveBackend(value: Backend | InjectionToken<Backend>, container: ContainerOps): Backend {
  // A backend is always an object; every valid key is a class, a `DeferredCtor`, or a branded string/symbol.
  if (
    typeof value === 'string' ||
    typeof value === 'symbol' ||
    typeof value === 'function' ||
    value instanceof DeferredCtor
  ) {
    const resolved = container.getOptional(value)
    if (resolved === undefined) {
      throw new ErrDistLockConfiguration(
        'Cannot install distributed locking: no binding registered for the given backend key' +
          '\n  - Bind the backend before the feature configures, or pass the instance itself to .backend(...)',
      )
    }

    return resolved
  }

  return value
}
