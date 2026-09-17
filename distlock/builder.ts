import { DeferredCtor, Scopes, type ContainerOps, type InjectionToken } from '@caffeinejs/di'
import { FeatureBuilder, kFeatureName, toMillis, type Duration, type FeatureConfigureKit } from '@caffeinejs/std'

import type { Backend } from './backend.js'
import type { DistLockConfigSlice } from './config.js'
import { CaffeineDistLock } from './distlock.js'
import { ErrDistLockConfiguration } from './errors.js'
import { kDistLock } from './keys.js'
import { DEFAULT_DIST_LOCK_OPTIONS, type DistLockOptions } from './options.js'

/**
 * Fluent configuration for the distributed lock service.
 *
 * The backend is the one thing with no default: pick it, and the rest of the settings only tune how long a
 * lease lasts and how hard `acquire` tries. Everything set here is final — configuration reaches the feature
 * because the application's callback wired it through {@link withConfig}, and a setter written in code beats
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
   * Reads the settings from a node of the configuration tree, e.g. `c.app.distlock`.
   *
   * The node is read once, when the feature configures. Every other method on this builder wins over what it
   * carries.
   */
  withConfig(config: Partial<DistLockConfigSlice>): this {
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

    // Keyed by the class, named by the token: the container reads `onDestroy` off a binding's constructor, and
    // a factory bound under a plain symbol has none to read, so renewal timers would outlive disposal. The
    // name is what user code resolves, since `DistLock` is an interface.
    kit.container.bind(CaffeineDistLock, t =>
      t
        .toFactory(ctx => new CaffeineDistLock(resolveBackend(backend, ctx.container), options))
        .names(kDistLock)
        .lifetime(Scopes.SINGLETON)
        .internal(),
    )
  }
}

function msOf(value: Duration | undefined): number | undefined {
  return value === undefined ? undefined : toMillis(value)
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
