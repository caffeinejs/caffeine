import {
  type BootstrapKit,
  type Feature,
  FeatureBuilder,
  type FeatureConfigurer,
  type FeatureConfigureKit,
  kFeatureName,
} from '@caffeinejs/application'
import type { AnyClass } from '@caffeinejs/di'
import type { Duration } from '@caffeinejs/std/duration'

import type { BulkheadOptions } from '../bulkhead/bulkhead.js'
import type { CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import type { RateLimiterOptions } from '../ratelimiter/ratelimiter.js'
import type { RetryOptions } from '../retry/retry.js'
import type { TimeLimiterOptions } from '../timelimiter/timelimiter.js'
import { ANNOTATIONS } from './annotations.js'
import { RESILIENCE_ASPECT_ORDER, ResilienceAspect, resiliencePointcut } from './aop.js'
import { type ResilienceDefinitions, ResilienceRegistry } from './registry.js'

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
    instances[name] = { ...fromConfig?.[name], ...fromCode.get(name) } as O
  }
  return instances
}

/**
 * Configures the named strategies the resilience annotations use, and weaves them into every method that carries
 * one, in the classes the container builds.
 *
 * An instance is defined by code, by configuration, or both; code wins, option by option. A method naming an instance
 * nothing defines, or a `@Fallback` naming a method its class lacks, fails `bootstrap()`.
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

  circuitBreaker(name: string, options: Omit<CircuitBreakerOptions, 'name'> = {}): this {
    this.#code.circuitBreakers.set(name, options)
    return this
  }

  retry(name: string, options: Omit<RetryOptions, 'name'> = {}): this {
    this.#code.retries.set(name, options)
    return this
  }

  timeLimiter(name: string, options: Partial<Omit<TimeLimiterOptions, 'name'>> = {}): this {
    this.#code.timeLimiters.set(name, options)
    return this
  }

  bulkhead(name: string, options: Omit<BulkheadOptions, 'name'> = {}): this {
    this.#code.bulkheads.set(name, options)
    return this
  }

  rateLimiter(name: string, options: Partial<Omit<RateLimiterOptions, 'name'>> = {}): this {
    this.#code.rateLimiters.set(name, options)
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
    const aspect = kit.container.get(ResilienceAspect)
    const classes = new Set<AnyClass>()
    for (const annotation of ANNOTATIONS) {
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
 * @throws {@link ErrInvalidOption} at `bootstrap()` when an instance's options are out of range, a method names an
 * instance nothing defines, or a `@Fallback` names a method its class lacks.
 */
export function Resilience<C = unknown>(configure?: FeatureConfigurer<ResilienceBuilder<C>, C>): Feature<C> {
  return new ResilienceBuilder<C>(configure as never)
}
