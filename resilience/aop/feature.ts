import {
  type BootstrapKit,
  type Feature,
  FeatureBuilder,
  type FeatureConfigurer,
  type FeatureConfigureKit,
  kFeatureName,
} from '@caffeinejs/application'
import { type AnyClass, reflect, token } from '@caffeinejs/di'
import type { Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import type { BulkheadOptions } from '../bulkhead/bulkhead.js'
import type { CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import { ErrInvalidOption } from '../errors.js'
import type { RateLimiterOptions } from '../ratelimiter/ratelimiter.js'
import type { RetryOptions } from '../retry/retry.js'
import type { TimeLimiterOptions } from '../timelimiter/timelimiter.js'
import { ANNOTATIONS, Retry } from './annotations.js'
import { RESILIENCE_ASPECT_ORDER, ResilienceAspect, resiliencePointcut } from './aop.js'
import { type ResilienceDefinitions, ResilienceRegistry } from './registry.js'

// Bound to `true` by `ResilienceHTTP()`. A controller's `@Retry` needs it: without the check, a handler for any method
// would replay.
export const kResilienceHTTP = token<boolean>('@caffeinejs/resilience:http')

// The label `@Controller` gives a class, registered so it is read here without importing the HTTP package.
const kController = Symbol.for('@caffeinejs/http:controller')

/** The circuit breaker options a configuration tree can carry: data only. */
export type CircuitBreakerConfig = Omit<
  CircuitBreakerOptions,
  'name' | 'waitDurationInOpenState' | 'recordError' | 'ignoreError' | 'recordResult'
> & { readonly waitDurationInOpenState?: Duration }

/** The retry options a configuration tree can carry: data only. */
export type RetryConfig = Omit<RetryOptions, 'name' | 'backoff' | 'retryOn' | 'retryOnResult'> & {
  readonly backoff?: Duration
}

export type TimeLimiterConfig = Partial<Omit<TimeLimiterOptions, 'name'>>
export type BulkheadConfig = Omit<BulkheadOptions, 'name'>
export type RateLimiterConfig = Partial<Omit<RateLimiterOptions, 'name'>>

/** What `Resilience(r => r.config(...))` takes: the data options of each named instance, by kind. */
export interface ResilienceConfig {
  readonly circuitBreakers?: Readonly<Record<string, CircuitBreakerConfig>>
  readonly retries?: Readonly<Record<string, RetryConfig>>
  readonly timeLimiters?: Readonly<Record<string, TimeLimiterConfig>>
  readonly bulkheads?: Readonly<Record<string, BulkheadConfig>>
  readonly rateLimiters?: Readonly<Record<string, RateLimiterConfig>>
}

type Kinds = keyof ResilienceConfig

// Each kind's instances: what configuration set, then what code set, merged per option with code winning.
function merged<O>(
  fromConfig: Readonly<Record<string, object>> | undefined,
  fromCode: Map<string, object>,
): Record<string, O> {
  const instances: Record<string, O> = {}
  for (const name of new Set([...Object.keys(fromConfig ?? {}), ...fromCode.keys()])) {
    const options: Record<string, unknown> = { ...fromConfig?.[name] }
    // An option code passes as `undefined` leaves the configured one in place.
    for (const [option, value] of Object.entries(fromCode.get(name) ?? {})) {
      if (value !== undefined) {
        options[option] = value
      }
    }
    instances[name] = options as O
  }
  return instances
}

/**
 * Configures the named strategies the resilience annotations use, and weaves them into every method that carries
 * one, in the classes the container builds.
 *
 * An instance is defined by code, by configuration, or both; code wins, option by option, and an option code passes as
 * `undefined` keeps the configured one. `bootstrap()` fails when code defines a name twice, a method names an instance
 * nothing defines, a `@Fallback` names a method its class lacks, an annotation is on a static method, or a controller
 * carries `@Retry` without `ResilienceHTTP()`.
 *
 * ```ts
 * .install(Resilience((r, { config }) => r.config(config.resilience).retry('inventory', { maxAttempts: 3 })))
 * ```
 */
export class ResilienceBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'resilience'

  #config: Partial<ResilienceConfig> | undefined
  readonly #code: Record<Kinds, Map<string, object>> = {
    circuitBreakers: new Map(),
    retries: new Map(),
    timeLimiters: new Map(),
    bulkheads: new Map(),
    rateLimiters: new Map(),
  }

  /** The instances the configuration tree defines. What code sets for an instance wins, option by option. */
  config(config: Partial<ResilienceConfig>): this {
    this.#config = config
    return this
  }

  /**
   * Defines the circuit breaker `name`, over what the configuration tree sets for it.
   *
   * @throws {@link ErrInvalidOption} when code already defined a circuit breaker of that name.
   */
  circuitBreaker(name: string, options: Omit<CircuitBreakerOptions, 'name'> = {}): this {
    return this.#define('circuitBreakers', 'circuit breaker', name, options)
  }

  /**
   * Defines the retry `name`, over what the configuration tree sets for it.
   *
   * @throws {@link ErrInvalidOption} when code already defined a retry of that name.
   */
  retry(name: string, options: Omit<RetryOptions, 'name'> = {}): this {
    return this.#define('retries', 'retry', name, options)
  }

  /**
   * Defines the time limiter `name`, over what the configuration tree sets for it.
   *
   * @throws {@link ErrInvalidOption} when code already defined a time limiter of that name.
   */
  timeLimiter(name: string, options: Partial<Omit<TimeLimiterOptions, 'name'>> = {}): this {
    return this.#define('timeLimiters', 'time limiter', name, options)
  }

  /**
   * Defines the bulkhead `name`, over what the configuration tree sets for it.
   *
   * @throws {@link ErrInvalidOption} when code already defined a bulkhead of that name.
   */
  bulkhead(name: string, options: Omit<BulkheadOptions, 'name'> = {}): this {
    return this.#define('bulkheads', 'bulkhead', name, options)
  }

  /**
   * Defines the rate limiter `name`, over what the configuration tree sets for it.
   *
   * @throws {@link ErrInvalidOption} when code already defined a rate limiter of that name.
   */
  rateLimiter(name: string, options: Partial<Omit<RateLimiterOptions, 'name'>> = {}): this {
    return this.#define('rateLimiters', 'rate limiter', name, options)
  }

  #define(kind: Kinds, label: string, name: string, options: object): this {
    const instances = this.#code[kind]
    if (instances.has(name)) {
      throw new ErrInvalidOption(
        errMessage(`Cannot define ${label} "${name}" twice`)
          .solutions(`Pass every option of "${name}" in one call`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }
    instances.set(name, options)
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const config = this.#config ?? {}
    const definitions: ResilienceDefinitions = {
      circuitBreakers: merged(config.circuitBreakers, this.#code.circuitBreakers),
      retries: merged(config.retries, this.#code.retries),
      timeLimiters: merged(config.timeLimiters, this.#code.timeLimiters),
      bulkheads: merged(config.bulkheads, this.#code.bulkheads),
      rateLimiters: merged(config.rateLimiters, this.#code.rateLimiters),
    }
    const registry = new ResilienceRegistry(definitions)

    kit.container.bind(ResilienceRegistry, t => t.toValue(registry))
    kit.container.aspect(ResilienceAspect, s =>
      s.toSelf([ResilienceRegistry]).pointcuts(resiliencePointcut).order(RESILIENCE_ASPECT_ORDER),
    )
  }

  protected override bootstrap(kit: BootstrapKit<C>): void {
    if (!kit.container.has(kResilienceHTTP)) {
      for (const { binding } of kit.container.getBindingsByLabel(kController)) {
        const cls = binding.type as AnyClass | undefined
        const retried = cls === undefined ? undefined : [...reflect.members(cls, Retry).keys()][0]
        if (retried !== undefined) {
          throw new ErrInvalidOption(
            errMessage(
              `Cannot retry "${cls!.name}.${String(retried)}": @Retry on a controller needs the HTTP replay check`,
            )
              .solutions(
                'Install ResilienceHTTP() from @caffeinejs/resilience/http',
                `Move @Retry('${reflect.members(cls!, Retry).get(retried)!.name}') to the outbound client method the handler calls`,
              )
              .reference('@caffeinejs/resilience', ErrInvalidOption)
              .build(),
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
      aspect.prepare(cls)
    }
  }
}

/**
 * Installs the resilience annotations: the named circuit breakers, retries, time limiters, bulkheads and rate
 * limiters they use, and the aspect that runs annotated methods through them.
 *
 * @throws {@link ErrInvalidOption} at `bootstrap()` when an instance's options are out of range, code defines a name
 * twice, a method names an instance nothing defines, a `@Fallback` names a method its class lacks, an annotation is on
 * a static method, or a controller carries `@Retry` without `ResilienceHTTP()`.
 */
export function Resilience<C = unknown>(configure?: FeatureConfigurer<ResilienceBuilder<C>, C>): Feature<C> {
  return new ResilienceBuilder<C>(configure as never)
}
