import { Scopes, type Ctor } from '@caffeinejs/di'
import {
  ErrConfigSourceConflict,
  HealthIndicator,
  kAppConfig,
  kServiceConfigure,
  type Duration,
  type Service,
  type ShutdownSignal,
  toMillis,
  type SignalDispatcher,
} from '@caffeinejs/std'
import type { ConfigHandle } from '@caffeinejs/std/config'
import type { ServiceKit } from '../service.js'
import { solutions } from '../error/util.js'
import { ErrHealthConfiguration } from './errors.js'
import { kHealthOptions } from './keys.js'
import {
  type HealthOptions,
  type HealthPaths,
  defaultHealthOptions,
  emitHealthWarnings,
  validateHealthOptions,
} from './options.js'

/** The application-config slice `.config(...)` selects. Every duration accepts `'5s'`-style strings or milliseconds. */
export interface HealthConfig {
  enabled?: boolean
  paths?: Partial<HealthPaths>
  drainDelay?: Duration
  shutdownTimeout?: Duration
  terminationGracePeriod?: Duration
  indicatorTimeout?: Duration
  probeDeadline?: Duration
  cacheTTL?: Duration
  verbose?: boolean
  exclude?: boolean
}

/**
 * Configures the health feature: the probe endpoints, the drain policy, and the signals that trigger it. Bound via
 * `app.health()` — calling it with no configuration at all is a complete, correct setup.
 *
 * Calling `app.health()` **enables** the probes regardless of environment; leaving it uncalled enables them only
 * when `KUBERNETES_SERVICE_HOST` is present. `.enabled(false)` always wins.
 *
 * A {@link Service}: its {@link kServiceConfigure} binds a fixed {@link HealthOptions} under {@link kHealthOptions}.
 * Like the server address, this is a one-time snapshot — a config refresh must not move the drain policy while a
 * shutdown is running — so the builder methods and the {@link config} selector are mutually exclusive and both
 * detach from the live config proxy.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 */
export class HealthBuilder<C = unknown> implements Service {
  #enabled: boolean | undefined
  #paths: Partial<HealthPaths> = {}
  #drainDelay: Duration | undefined
  #shutdownTimeout: Duration | undefined
  #terminationGracePeriod: Duration | undefined
  #indicatorTimeout: Duration | undefined
  #probeDeadline: Duration | undefined
  #cacheTTL: Duration | undefined
  #verbose: boolean | undefined
  #exclude: boolean | undefined
  #signals: readonly ShutdownSignal[] | false | undefined
  #dispatcher: SignalDispatcher | undefined
  readonly #indicators: Array<HealthIndicator | Ctor<HealthIndicator>> = []
  #usedBuilderFn = false
  #selector: ((c: ConfigHandle<C>) => HealthConfig) | undefined

  /** Forces the probes on or off, overriding the Kubernetes auto-detection. */
  enabled(enabled: boolean = true): this {
    this.#enabled = enabled
    this.#usedBuilderFn = true
    return this
  }

  /** Overrides one or more probe paths. Defaults: `/livez`, `/readyz`, `/startupz`. */
  paths(paths: Partial<HealthPaths>): this {
    this.#paths = { ...this.#paths, ...paths }
    this.#usedBuilderFn = true
    return this
  }

  /**
   * How long to keep serving after readiness starts refusing, before the server closes. Covers the orchestrator's
   * routing-table propagation lag; traffic still arrives during this window and is answered normally.
   */
  drainDelay(delay: Duration): this {
    this.#drainDelay = delay
    this.#usedBuilderFn = true
    return this
  }

  /** The budget for in-flight requests to finish once the server is closing. */
  shutdownTimeout(timeout: Duration): this {
    this.#shutdownTimeout = timeout
    this.#usedBuilderFn = true
    return this
  }

  /**
   * The pod's `terminationGracePeriodSeconds`. It cannot be read from inside the pod, so it must be mirrored here
   * (or injected through the downward API) for the boot-time budget check to mean anything.
   */
  terminationGracePeriod(period: Duration): this {
    this.#terminationGracePeriod = period
    this.#usedBuilderFn = true
    return this
  }

  /** Per-indicator budget. An indicator exceeding it is aborted and reported down. */
  indicatorTimeout(timeout: Duration): this {
    this.#indicatorTimeout = timeout
    this.#usedBuilderFn = true
    return this
  }

  /** Whole-probe budget, regardless of indicator count. */
  probeDeadline(deadline: Duration): this {
    this.#probeDeadline = deadline
    this.#usedBuilderFn = true
    return this
  }

  /** How long an evaluation is reused. Bounds the load the probes place on the dependencies they check. */
  cacheTTL(ttl: Duration): this {
    this.#cacheTTL = ttl
    this.#usedBuilderFn = true
    return this
  }

  /** Allows `?verbose` to expand the response body. Off by default: the body names your dependencies. */
  verbose(verbose: boolean = true): this {
    this.#verbose = verbose
    this.#usedBuilderFn = true
    return this
  }

  /** Allows `?exclude=<name>` to skip an indicator. Off by default: it lets a caller make readiness lie. */
  exclude(exclude: boolean = true): this {
    this.#exclude = exclude
    this.#usedBuilderFn = true
    return this
  }

  /** The signals that trigger a graceful shutdown, or `false` to install no handlers. */
  signals(signals: readonly ShutdownSignal[] | false): this {
    this.#signals = signals
    this.#usedBuilderFn = true
    return this
  }

  /**
   * Replaces the {@link SignalDispatcher} that delivers signals and diagnostics. The host runtime's is detected
   * automatically and covers Node, Bun and Deno; supply one to bridge a runtime with native signal handling of its
   * own, or to observe the shutdown in a test.
   */
  dispatcher(dispatcher: SignalDispatcher): this {
    this.#dispatcher = dispatcher
    this.#usedBuilderFn = true
    return this
  }

  /**
   * Registers a health indicator. Equivalent to binding it yourself with `.extends(HealthIndicator)`; both are
   * discovered the same way.
   */
  indicator(indicator: HealthIndicator | Ctor<HealthIndicator>): this {
    this.#indicators.push(indicator)
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (this.#selector !== undefined && this.#usedBuilderFn) {
      throw new ErrConfigSourceConflict('health')
    }

    for (const indicator of this.#indicators) {
      if (typeof indicator === 'function') {
        kit.container.bind(indicator).toSelf().lifetime(Scopes.SINGLETON).extends(HealthIndicator)
      } else {
        kit.container
          .bind(indicator.constructor as Ctor<HealthIndicator>)
          .toValue(indicator)
          .extends(HealthIndicator)
      }
    }

    kit.feats.toggleHealth()

    if (this.#selector !== undefined) {
      const container = kit.container
      const selector = this.#selector

      kit.container
        .bind<HealthOptions>(kHealthOptions)
        // Lazy so `kAppConfig` (bound during init) is available; runs once, then the singleton caches it.
        .toFactory(() => {
          const appConfig = container.getOptional<ConfigHandle<C>>(kAppConfig)
          if (appConfig === undefined) {
            throw new ErrHealthConfiguration(
              'Cannot select health config: no application config is defined'
              + solutions(
                'Declare .config(schema, ...) on the application builder before configuring health',
                'Configure health with the builder methods instead of .config(...)',
              ),
            )
          }

          return finalize(fromConfig(selector(appConfig), this.#dispatcher))
        })
        .internal()

      return Promise.resolve()
    }

    kit.container
      .bind<HealthOptions>(kHealthOptions)
      .toValue(finalize(this.#fromBuilder()))
      .internal()

    return Promise.resolve()
  }

  /** Drives the health configuration from the application config, e.g. `h.config(c => c.health)`. */
  config(selector: (c: ConfigHandle<C>) => HealthConfig): this {
    this.#selector = selector
    return this
  }

  #fromBuilder(): HealthOptions {
    const defaults = defaultHealthOptions()

    return {
      // Reaching the builder at all is an explicit opt-in, so the Kubernetes auto-detection no longer decides.
      enabled: this.#enabled ?? true,
      paths: { ...defaults.paths, ...this.#paths },
      drainDelayMs: pick(this.#drainDelay, defaults.drainDelayMs),
      shutdownTimeoutMs: pick(this.#shutdownTimeout, defaults.shutdownTimeoutMs),
      terminationGracePeriodMs: pick(this.#terminationGracePeriod, defaults.terminationGracePeriodMs),
      indicatorTimeoutMs: pick(this.#indicatorTimeout, defaults.indicatorTimeoutMs),
      probeDeadlineMs: pick(this.#probeDeadline, defaults.probeDeadlineMs),
      cacheTTLMs: pick(this.#cacheTTL, defaults.cacheTTLMs),
      verbose: this.#verbose ?? defaults.verbose,
      exclude: this.#exclude ?? defaults.exclude,
      signals: this.#signals ?? defaults.signals,
      dispatcher: this.#dispatcher ?? defaults.dispatcher,
    }
  }
}

function fromConfig(config: HealthConfig, dispatcher: SignalDispatcher | undefined): HealthOptions {
  const defaults = defaultHealthOptions()

  return {
    enabled: config.enabled ?? true,
    paths: { ...defaults.paths, ...config.paths },
    drainDelayMs: pick(config.drainDelay, defaults.drainDelayMs),
    shutdownTimeoutMs: pick(config.shutdownTimeout, defaults.shutdownTimeoutMs),
    terminationGracePeriodMs: pick(config.terminationGracePeriod, defaults.terminationGracePeriodMs),
    indicatorTimeoutMs: pick(config.indicatorTimeout, defaults.indicatorTimeoutMs),
    probeDeadlineMs: pick(config.probeDeadline, defaults.probeDeadlineMs),
    cacheTTLMs: pick(config.cacheTTL, defaults.cacheTTLMs),
    verbose: config.verbose ?? defaults.verbose,
    exclude: config.exclude ?? defaults.exclude,
    signals: defaults.signals,
    dispatcher: dispatcher ?? defaults.dispatcher,
  }
}

function finalize(options: HealthOptions): HealthOptions {
  const validated = validateHealthOptions(options)
  emitHealthWarnings(validated.warnings, options.dispatcher)
  return validated.options
}

function pick(value: Duration | undefined, fallback: number): number {
  return value === undefined ? fallback : toMillis(value)
}
