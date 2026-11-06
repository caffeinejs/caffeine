import {
  type BootstrapKit,
  type Feature,
  FeatureBuilder,
  type FeatureConfigurer,
  type FeatureConfigureKit,
  kFeatureName,
} from '@caffeinejs/application'
import { type AnyClass, token } from '@caffeinejs/di'
import type { Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { exponential, type ExponentialOptions } from '../backoff.js'
import type { BulkheadOptions } from '../bulkhead/bulkhead.js'
import type { CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import { described, ErrInvalidOption } from '../errors.js'
import type { RateLimiterOptions } from '../ratelimiter/ratelimiter.js'
import type { RetryOptions } from '../retry/retry.js'
import type { TimeLimiterOptions } from '../timelimiter/timelimiter.js'
import { ANNOTATIONS } from './annotations.js'
import { RESILIENCE_ASPECT_ORDER, ResilienceAspect, resiliencePointcut } from './aop.js'
import {
  labelOf,
  type PresetDefinition,
  type ResilienceDefinitions,
  type ResilienceKind,
  ResilienceRegistry,
} from './registry.js'
import { annotatedMembers, stagesOf, written } from './stages.js'

// Bound to `true` by `ResilienceHTTP()`. A retried controller needs it: without the check, a handler for any method
// would replay.
export const kResilienceHTTP = token<boolean>('@caffeinejs/resilience:http')

// The label `@Controller` gives a class, registered so it is read here without importing the HTTP package.
const kController = Symbol.for('@caffeinejs/http:controller')

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

/** What `Resilience(r => r.config(...))` takes: the presets, by name, and the order. */
export interface ResilienceConfig {
  /** The order of the policies around an annotated method, as `r.order(...)` sets it. */
  readonly order?: readonly ResilienceKind[]
  readonly presets?: Readonly<Record<string, PresetConfig>>
}

const KINDS: readonly ResilienceKind[] = ['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead']

// What code sets for one option wins over what configuration sets; an option code passes as `undefined` leaves the
// configured one in place.
function mergedOptions(fromConfig: object | undefined, fromCode: object | undefined): object {
  const options: Record<string, unknown> = { ...fromConfig }
  for (const [option, value] of Object.entries(fromCode ?? {})) {
    if (value !== undefined) {
      options[option] = value
    }
  }
  return options
}

// The backoff a retry takes for the one configuration describes.
function backoffOf(preset: string, backoff: unknown): RetryOptions['backoff'] {
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
      `Cannot define the retry of preset "${preset}": the configured backoff must be an object of type "fixed" or "exponential", got ${got}`,
    )
      .solutions(
        "Set backoff to { type: 'exponential' } and its options, such as initialDelay: 200 * Millisecond",
        "Set backoff to { type: 'fixed', delay } for a wait that never changes, such as delay: 1 * Second",
      )
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

// A configured preset with its retry's backoff as a retry takes it.
function withBackoff(
  name: string,
  preset: PresetConfig | undefined,
): Record<ResilienceKind, object | undefined> | undefined {
  const retry = preset?.retry
  if (retry?.backoff === undefined) {
    return preset as Record<ResilienceKind, object | undefined> | undefined
  }
  return { ...preset, retry: { ...retry, backoff: backoffOf(name, retry.backoff) } } as Record<
    ResilienceKind,
    object | undefined
  >
}

// Every preset either side defines, each policy either side defines in it, merged option by option.
function mergedPresets(
  fromConfig: Readonly<Record<string, PresetConfig>> | undefined,
  fromCode: Map<string, PresetDefinition>,
): ResilienceDefinitions {
  const presets: Record<string, PresetDefinition> = {}
  for (const name of new Set([...Object.keys(fromConfig ?? {}), ...fromCode.keys()])) {
    const configured = withBackoff(name, fromConfig?.[name])
    const coded = fromCode.get(name) as Record<ResilienceKind, object | undefined> | undefined
    const preset: Partial<Record<ResilienceKind, object>> = {}
    for (const kind of KINDS) {
      if (configured?.[kind] !== undefined || coded?.[kind] !== undefined) {
        preset[kind] = mergedOptions(configured?.[kind], coded?.[kind])
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
  readonly #name: string
  readonly #policies: Partial<Record<ResilienceKind, object>>

  constructor(name: string, policies: Partial<Record<ResilienceKind, object>>) {
    this.#name = name
    this.#policies = policies
  }

  /** @throws {@link ErrInvalidOption} when the preset already defines a circuit breaker. */
  circuitBreaker(options: Omit<CircuitBreakerOptions, 'name'> = {}): this {
    return this.#define('circuitBreaker', options)
  }

  /** @throws {@link ErrInvalidOption} when the preset already defines a retry. */
  retry(options: Omit<RetryOptions, 'name'> = {}): this {
    return this.#define('retry', options)
  }

  /** @throws {@link ErrInvalidOption} when the preset already defines a time limiter. */
  timeLimiter(options: Partial<Omit<TimeLimiterOptions, 'name'>> = {}): this {
    return this.#define('timeLimiter', options)
  }

  /** @throws {@link ErrInvalidOption} when the preset already defines a bulkhead. */
  bulkhead(options: Omit<BulkheadOptions, 'name'> = {}): this {
    return this.#define('bulkhead', options)
  }

  /** @throws {@link ErrInvalidOption} when the preset already defines a rate limiter. */
  rateLimiter(options: Partial<Omit<RateLimiterOptions, 'name'>> = {}): this {
    return this.#define('rateLimiter', options)
  }

  #define(kind: ResilienceKind, options: object): this {
    if (this.#policies[kind] !== undefined) {
      throw new ErrInvalidOption(
        errMessage(`Cannot define the ${labelOf(kind)} of preset "${this.#name}" twice`)
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
 * `undefined` keeps the configured one; configuration may add a policy code left out. `bootstrap()` fails when code
 * defines a preset or one of its policies twice, a preset defines no policy, a method names a preset nothing defines
 * or a policy its preset lacks, a `@Fallback` names a method its class lacks, an annotation is on a static or a
 * private method, a controller is retried without `ResilienceHTTP()`, the order does not list each kind once, or a
 * bulkhead or rate limiter inside a method's time limiter may wait as long as its limit.
 *
 * ```ts
 * .install(Resilience((r, { config }) => r.config(config.resilience).preset('inventory', p => p.retry().circuitBreaker())))
 * ```
 */
export class ResilienceBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'resilience'

  #config: Partial<ResilienceConfig> | undefined
  #order: readonly ResilienceKind[] | undefined
  readonly #presets = new Map<string, PresetDefinition>()

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

    const policies: Partial<Record<ResilienceKind, object>> = {}
    configure(new PresetBuilder(name, policies))
    this.#presets.set(name, policies as PresetDefinition)
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const config = this.#config ?? {}
    const registry = new ResilienceRegistry(mergedPresets(config.presets, this.#presets))
    const aspect = new ResilienceAspect(registry, this.#order ?? config.order)

    // Disposed at shutdown, so no backoff or queued call holds it.
    kit.container.bind(ResilienceRegistry, t => t.toValue(registry).preDestroy(instances => instances.dispose()))
    kit.container.aspect(ResilienceAspect, s =>
      s.toValue(aspect).pointcuts(resiliencePointcut).order(RESILIENCE_ASPECT_ORDER),
    )
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    if (!kit.container.has(kResilienceHTTP)) {
      const registry = kit.container.get(ResilienceRegistry)
      for (const { binding } of kit.container.getBindingsByLabel(kController)) {
        const cls = binding.type as AnyClass | undefined
        for (const member of cls === undefined ? [] : annotatedMembers(cls)) {
          const retry = stagesOf(cls!, member, registry).stages.retry
          if (retry !== undefined) {
            throw new ErrInvalidOption(
              errMessage(
                `Cannot retry "${cls!.name}.${String(member)}": ${written(retry)} retries a controller, which needs the HTTP replay check`,
              )
                .solutions(
                  'Install ResilienceHTTP() from @caffeinejs/resilience/http',
                  `Move ${written(retry)} to the outbound client method the handler calls`,
                )
                .reference('@caffeinejs/resilience', ErrInvalidOption)
                .build(),
            )
          }
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
      aspect.prepare(cls)
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
