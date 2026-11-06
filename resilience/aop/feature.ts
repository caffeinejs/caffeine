import {
  type BootstrapKit,
  type Feature,
  FeatureBuilder,
  type FeatureConfigurer,
  type FeatureConfigureKit,
  kFeatureName,
} from '@caffeinejs/application'
import { HealthIndicator } from '@caffeinejs/application/health'
import { type AnyClass, reflect } from '@caffeinejs/di'
import type { Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { exponential, type ExponentialOptions } from '../backoff.js'
import type { BulkheadOptions } from '../bulkhead/bulkhead.js'
import type { CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import { described, ErrInvalidOption } from '../errors.js'
import type { RateLimiterOptions } from '../ratelimiter/ratelimiter.js'
import type { RetryOptions } from '../retry/retry.js'
import type { TimeLimiterOptions } from '../timelimiter/timelimiter.js'
import { ANNOTATIONS, Fallback } from './annotations.js'
import { RESILIENCE_ASPECT_ORDER, ResilienceAspect, resiliencePointcut } from './aop.js'
import { checkedStorage, ResilienceContext, type ResilienceContextStorage } from './context.js'
import { criticalBreakers, ResilienceHealthIndicator, type ResilienceHealthOptions } from './health.js'
import {
  labelOf,
  type PresetDefinition,
  type ResilienceDefinitions,
  type ResilienceKind,
  ResilienceRegistry,
} from './registry.js'
import { stagesOf, written, wovenMembers } from './stages.js'
import { kEntrypoint, ResilienceTransport } from './transport.js'

/** The circuit breaker options a configuration tree can carry: data only. */
export type CircuitBreakerConfig = Omit<
  CircuitBreakerOptions,
  'name' | 'waitDurationInOpenState' | 'recordError' | 'ignoreError' | 'recordResult' | 'clock'
> & { readonly waitDurationInOpenState?: Duration }

/**
 * A backoff a configuration tree can carry: a fixed delay, or an exponential one with the options `exponential()`
 * takes, each defaulted as there.
 */
export type BackoffConfig =
  | { readonly type: 'fixed'; readonly delay: Duration }
  | ({ readonly type: 'exponential' } & Readonly<ExponentialOptions>)

/** The retry options a configuration tree can carry: data only. A backoff code sets replaces the configured one. */
export type RetryConfig = Omit<RetryOptions, 'name' | 'backoff' | 'retryOn' | 'retryOnResult' | 'discard' | 'clock'> & {
  readonly backoff?: BackoffConfig
}

export type TimeLimiterConfig = Partial<Omit<TimeLimiterOptions, 'name' | 'discard' | 'clock'>>
export type BulkheadConfig = Omit<BulkheadOptions, 'name' | 'clock'>
export type RateLimiterConfig = Partial<Omit<RateLimiterOptions, 'name' | 'clock'>>

/** The policies one preset's configuration can define, by kind: data only. */
export interface PresetConfig {
  readonly circuitBreaker?: CircuitBreakerConfig
  readonly retry?: RetryConfig
  readonly timeLimiter?: TimeLimiterConfig
  readonly bulkhead?: BulkheadConfig
  readonly rateLimiter?: RateLimiterConfig
}

/** What `Resilience(r => r.config(...))` takes: the presets, by name, the defaults and the order. */
export interface ResilienceConfig {
  /** The order of the policies around an annotated method, as `r.order(...)` sets it. */
  readonly order?: readonly ResilienceKind[]
  /** The options every policy of a kind starts from, as `r.defaults(...)` sets them. They never add a policy. */
  readonly defaults?: PresetConfig
  readonly presets?: Readonly<Record<string, PresetConfig>>
}

const KINDS: readonly ResilienceKind[] = ['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead']

type Policies = Partial<Record<ResilienceKind, object>>

// Each layer wins over the ones before it, option by option; an option a layer passes as `undefined` leaves the one
// before in place.
function mergedOptions(...layers: (object | undefined)[]): object {
  const options: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [option, value] of Object.entries(layer ?? {})) {
      if (value !== undefined) {
        options[option] = value
      }
    }
  }
  return options
}

// A request entrypoint no installed transport claims. Installing that transport's integration is the likely fix, and
// HTTP's comes first, since a controller is the entrypoint most applications have.
function unclaimed(cls: AnyClass, problem: string, ...solutions: string[]): ErrInvalidOption {
  return new ErrInvalidOption(
    errMessage(problem)
      .solutions(
        `Install ResilienceHTTP() from @caffeinejs/resilience/http with .install(ResilienceHTTP()) if "${cls.name}" is an HTTP controller`,
        `Install the resilience integration of the transport that serves "${cls.name}" if it is not an HTTP controller`,
        ...solutions,
      )
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

// The backoff a retry takes for the one configuration describes.
function backoffOf(where: string, backoff: unknown): RetryOptions['backoff'] {
  const { type, delay, ...options } = (typeof backoff === 'object' && backoff !== null ? backoff : {}) as {
    type?: unknown
    delay?: Duration
  } & ExponentialOptions
  if (type === 'fixed') {
    return delay
  }
  if (type === 'exponential') {
    return exponential(options)
  }

  const got = typeof type === 'string' ? `type "${type}"` : described(backoff)
  throw new ErrInvalidOption(
    errMessage(
      `Cannot define the retry of ${where}: the configured backoff must be an object of type "fixed" or "exponential", got ${got}`,
    )
      .solutions(
        "Set backoff to { type: 'exponential' } and its options, such as initialDelay: 200 * Millisecond",
        "Set backoff to { type: 'fixed', delay } for a wait that never changes, such as delay: 1 * Second",
      )
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

// Configured policies with the retry's backoff as a retry takes it.
function withBackoff(where: string, policies: PresetConfig | undefined): Policies | undefined {
  const retry = policies?.retry
  if (retry?.backoff === undefined) {
    return policies as Policies | undefined
  }
  return { ...policies, retry: { ...retry, backoff: backoffOf(where, retry.backoff) } }
}

// Every preset either side defines, each policy either side defines in it, merged option by option over the defaults:
// built in, then configured defaults, coded defaults, the configured preset and the coded preset.
function mergedPresets(
  config: Partial<ResilienceConfig>,
  fromCode: Map<string, Policies>,
  codedDefaults: Policies | undefined,
): ResilienceDefinitions {
  const configuredDefaults = withBackoff('the defaults', config.defaults)
  const presets: Record<string, PresetDefinition> = {}
  for (const name of new Set([...Object.keys(config.presets ?? {}), ...fromCode.keys()])) {
    const configured = withBackoff(`preset "${name}"`, config.presets?.[name])
    const coded = fromCode.get(name)
    const preset: Policies = {}
    for (const kind of KINDS) {
      if (configured?.[kind] !== undefined || coded?.[kind] !== undefined) {
        preset[kind] = mergedOptions(
          configuredDefaults?.[kind],
          codedDefaults?.[kind],
          configured?.[kind],
          coded?.[kind],
        )
      }
    }

    if (Object.keys(preset).length === 0) {
      throw new ErrInvalidOption(
        errMessage(`Cannot define preset "${name}": it defines no policy`)
          .solutions(`Add one with r.preset('${name}', p => p.retry({ ... }))`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
    presets[name] = preset as PresetDefinition
  }
  return presets
}

/**
 * The policies one preset defines, at most one of each kind, each named after the preset. The order of the calls is
 * not the order the policies run in: `p.timeLimiter().retry()` still runs the retry outside the time limiter.
 */
export class PresetBuilder {
  readonly #where: string
  readonly #policies: Policies

  /** `where` names what is built in messages: `preset "inventory"` or `the defaults`. */
  constructor(where: string, policies: Policies) {
    this.#where = where
    this.#policies = policies
  }

  /** @throws {@link ErrInvalidOption} when it already defines a circuit breaker. */
  circuitBreaker(options: Omit<CircuitBreakerOptions, 'name'> = {}): this {
    return this.#define('circuitBreaker', options)
  }

  /** @throws {@link ErrInvalidOption} when it already defines a retry. */
  retry(options: Omit<RetryOptions, 'name'> = {}): this {
    return this.#define('retry', options)
  }

  /** @throws {@link ErrInvalidOption} when it already defines a time limiter. */
  timeLimiter(options: Partial<Omit<TimeLimiterOptions, 'name'>> = {}): this {
    return this.#define('timeLimiter', options)
  }

  /** @throws {@link ErrInvalidOption} when it already defines a bulkhead. */
  bulkhead(options: Omit<BulkheadOptions, 'name'> = {}): this {
    return this.#define('bulkhead', options)
  }

  /** @throws {@link ErrInvalidOption} when it already defines a rate limiter. */
  rateLimiter(options: Partial<Omit<RateLimiterOptions, 'name'>> = {}): this {
    return this.#define('rateLimiter', options)
  }

  #define(kind: ResilienceKind, options: object): this {
    if (this.#policies[kind] !== undefined) {
      throw new ErrInvalidOption(
        errMessage(`Cannot define the ${labelOf(kind)} of ${this.#where} twice`)
          .solutions(`Pass every option of the ${labelOf(kind)} in one p.${kind}({ ... }) call`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
    this.#policies[kind] = options
    return this
  }
}

/**
 * Defines the presets the resilience annotations name, and weaves them into every method that carries one, in the
 * classes the container builds.
 *
 * A preset is defined by code, by configuration, or both. Code wins, option by option, and an option code passes as
 * `undefined` keeps the configured one; configuration may add a policy code left out, and the defaults fill what both
 * leave open. `bootstrap()` fails when code defines a preset, the defaults or one of their policies twice, a preset
 * defines no policy, a method names a preset nothing defines or a policy its preset lacks, a `@Fallback` names a
 * method its class lacks, an annotation is on a static or a private method, a request entrypoint carries a retry, a
 * circuit breaker or a fallback with no transport integration installed, such as `ResilienceHTTP()` for a controller,
 * `r.health(...)` is called twice or its `critical` names a breaker it cannot watch, the order does not list each kind
 * once, or a bulkhead or rate limiter inside a method's time limiter may wait as long as its limit.
 *
 * ```ts
 * .install(Resilience((r, { config }) => r.config(config.resilience).preset('inventory', p => p.retry().circuitBreaker())))
 * ```
 */
export class ResilienceBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'resilience'

  #config: Partial<ResilienceConfig> | undefined
  #order: readonly ResilienceKind[] | undefined
  readonly #presets = new Map<string, Policies>()
  #defaults: Policies | undefined
  #storage: ResilienceContextStorage | undefined
  #health: ResilienceHealthOptions | undefined

  /** The presets the configuration tree defines. What code sets for a preset's policy wins, option by option. */
  config(config: Partial<ResilienceConfig>): this {
    this.#config = config
    return this
  }

  /**
   * Sets the order of the policies around every annotated method, outermost first, each kind once; a fallback is
   * always outermost. Defaults to `['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead']`, where a
   * bulkhead inside the time limiter keeps the slot of a call that timed out until the call ends.
   */
  order(order: readonly ResilienceKind[]): this {
    this.#order = order
    return this
  }

  /**
   * Defines the preset `name`: at most one policy of each kind, each named `name`, over what the configuration tree
   * sets for it. `@Resilient(name)` runs all of them; `@Retry(name)` and the other stage annotations take one.
   *
   * @throws {@link ErrInvalidOption} when code already defined a preset of that name, or `configure` defines one
   * policy twice.
   */
  preset(name: string, configure: (preset: PresetBuilder) => unknown): this {
    if (this.#presets.has(name)) {
      throw new ErrInvalidOption(
        errMessage(`Cannot define preset "${name}" twice`)
          .solutions(`Define every policy of "${name}" in one r.preset('${name}', p => ...) call`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    const policies: Policies = {}
    configure(new PresetBuilder(`preset "${name}"`, policies))
    this.#presets.set(name, policies)
    return this
  }

  /**
   * Sets the options every policy of a kind starts from, in every preset, over what the configuration tree's
   * `defaults` sets. A default shapes a policy a preset defines and never adds one: `r.defaults(p => p.circuitBreaker())`
   * gives no preset a breaker. Lowest first, an option comes from the built-in default, the configured defaults, these,
   * the configured preset, then the preset in code.
   *
   * @throws {@link ErrInvalidOption} when called twice, or `configure` defines one policy twice.
   */
  defaults(configure: (defaults: PresetBuilder) => unknown): this {
    if (this.#defaults !== undefined) {
      throw new ErrInvalidOption(
        errMessage('Cannot define the defaults twice')
          .solutions('Define every default in one r.defaults(p => ...) call')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    this.#defaults = {}
    configure(new PresetBuilder('the defaults', this.#defaults))
    return this
  }

  /**
   * Runs every attempt of an annotated method inside `storage`, so an injected {@link ResilienceContext} reads the
   * attempt's signal and number anywhere below the method: `r.context(new AsyncLocalStorage())`. The package imports
   * nothing from Node; any object with `run(store, callback)` and `getStore()` works.
   *
   * @throws {@link ErrInvalidOption} when `storage` has no `run` or no `getStore` method.
   */
  context(storage: ResilienceContextStorage): this {
    this.#storage = checkedStorage(storage)
    return this
  }

  /**
   * Reports every circuit breaker to the readiness probe, as the health indicator `resilience`: an open breaker
   * reports `degraded`, and fails readiness only when its preset is in `critical`. Without it, no indicator is bound.
   *
   * A critical breaker must set `automaticTransitionFromOpenToHalfOpen: true`: while readiness fails, no call comes to
   * move it on.
   *
   * @throws {@link ErrInvalidOption} when called twice; at start-up, when `critical` names a preset with no circuit
   * breaker, or one without `automaticTransitionFromOpenToHalfOpen`.
   */
  health(options: ResilienceHealthOptions = {}): this {
    if (this.#health !== undefined) {
      throw new ErrInvalidOption(
        errMessage('Cannot report the resilience health twice')
          .solutions('Pass every option in one r.health({ ... }) call')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
    this.#health = options
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const config = this.#config ?? {}
    const definitions = mergedPresets(config, this.#presets, this.#defaults)
    const registry = new ResilienceRegistry(definitions)
    const aspect = new ResilienceAspect(registry, this.#order ?? config.order, this.#storage)

    // Disposed at shutdown, so no backoff or queued call holds it.
    kit.container.bind(ResilienceRegistry, t => t.toValue(registry).preDestroy(instances => instances.dispose()))
    kit.container.bind(ResilienceContext, t => t.toValue(new ResilienceContext(this.#storage)))
    if (this.#health !== undefined) {
      const indicator = new ResilienceHealthIndicator(registry, criticalBreakers(this.#health, definitions))
      kit.container.bind(ResilienceHealthIndicator, t => t.toValue(indicator).extends(HealthIndicator))
    }
    kit.container.aspect(ResilienceAspect, s =>
      s.toValue(aspect).pointcuts(resiliencePointcut).order(RESILIENCE_ASPECT_ORDER),
    )
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    // A retried entrypoint replays a request, and a breaker or a fallback on one judges its client's errors: only the
    // transport that serves it can tell whether a replay is safe and which errors are the client's. The bootstrap kit
    // has no getManyOptional, and getMany refuses a key nothing binds.
    const transports =
      kit.container.getBindings(ResilienceTransport).length === 0 ? [] : kit.container.getMany(ResilienceTransport)
    const claimed = new Map(transports.map(transport => [transport.label, transport]))
    const registry = kit.container.get(ResilienceRegistry)
    // The transport that claims each entrypoint class, which tells its client errors apart.
    const served = new Map<AnyClass, ResilienceTransport>()
    for (const { binding } of kit.container.getBindingsByLabel(kEntrypoint)) {
      const cls = binding.type as AnyClass | undefined
      if (cls === undefined) {
        continue
      }
      const label = binding.labels.find(other => claimed.has(other))
      if (label !== undefined) {
        served.set(cls, claimed.get(label)!)
        continue
      }
      for (const member of wovenMembers(cls)) {
        const where = `${cls.name}.${String(member)}`
        const { retry, circuitBreaker } = stagesOf(cls, member, registry).stages
        if (retry !== undefined) {
          throw unclaimed(
            cls,
            `Cannot retry "${where}": ${written(retry)} retries a request entrypoint that no installed transport integration checks`,
            `Move ${written(retry)} to the outbound client method that "${where}" calls`,
          )
        }
        // A breaker and a fallback judge errors: with no transport to tell them apart, a client's own errors would open
        // the one and reach the other. The other policies treat every error alike.
        if (circuitBreaker !== undefined) {
          throw unclaimed(
            cls,
            `Cannot weave "${where}": no installed transport integration claims this request entrypoint, so ${written(circuitBreaker)} would count a client's own error, such as a 404 it throws, as a failure`,
            `Move ${written(circuitBreaker)} to the outbound client method that "${where}" calls`,
          )
        }
        const recovery = reflect.effective(cls, Fallback, member)
        if (recovery !== undefined) {
          throw unclaimed(
            cls,
            `Cannot weave "${where}": no installed transport integration claims this request entrypoint, so @Fallback('${String(recovery.method)}') would answer a client's own error, such as a 403 it throws`,
          )
        }
      }
    }

    const aspect = kit.container.get(ResilienceAspect)
    const classes = new Set<AnyClass>()
    for (const annotation of ANNOTATIONS.keys()) {
      for (const { binding } of kit.container.getBindingsByAnnotation(annotation)) {
        if (binding.type !== undefined) {
          classes.add(binding.type as AnyClass)
        }
      }
    }

    for (const cls of classes) {
      aspect.prepare(cls, served.get(cls))
    }
  }
}

/**
 * Installs the resilience annotations: the presets they name, each a set of named circuit breakers, retries, time
 * limiters, bulkheads and rate limiters, and the aspect that runs annotated methods through them.
 *
 * @throws {@link ErrInvalidOption} at `bootstrap()` when a policy's options are out of range, or for any of the
 * reasons {@link ResilienceBuilder} lists.
 */
export function Resilience<C = unknown>(configure?: FeatureConfigurer<ResilienceBuilder<C>, C>): Feature<C> {
  return new ResilienceBuilder<C>(configure as never)
}
