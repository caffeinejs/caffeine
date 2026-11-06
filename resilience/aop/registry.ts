import { errMessage } from '@caffeinejs/std/err'

import { type Bulkhead, bulkhead, type BulkheadOptions } from '../bulkhead/bulkhead.js'
import { type CircuitBreaker, circuitBreaker, type CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import { disposable } from '../dispose.js'
import { ErrInvalidOption } from '../errors.js'
import type { Fallback } from '../fallback/fallback.js'
import { type RateLimiter, rateLimiter, type RateLimiterOptions } from '../ratelimiter/ratelimiter.js'
import { type Retry, retry, type RetryOptions } from '../retry/retry.js'
import { type TimeLimiter, timeLimiter, type TimeLimiterOptions } from '../timelimiter/timelimiter.js'

/** A kind of policy a preset can define, one of each at most. */
export type ResilienceKind = 'circuitBreaker' | 'retry' | 'timeLimiter' | 'bulkhead' | 'rateLimiter'

/** The options of each policy one preset defines, by kind. */
export interface PresetDefinition {
  readonly circuitBreaker?: Omit<CircuitBreakerOptions, 'name'>
  readonly retry?: Omit<RetryOptions, 'name'>
  readonly timeLimiter?: Omit<TimeLimiterOptions, 'name'>
  readonly bulkhead?: Omit<BulkheadOptions, 'name'>
  readonly rateLimiter?: Omit<RateLimiterOptions, 'name'>
}

/** The presets, by name. Each policy a preset defines is named after it. */
export type ResilienceDefinitions = Readonly<Record<string, PresetDefinition>>

const LABELS: Record<ResilienceKind, string> = {
  circuitBreaker: 'circuit breaker',
  retry: 'retry',
  timeLimiter: 'time limiter',
  bulkhead: 'bulkhead',
  rateLimiter: 'rate limiter',
}

// How the aspect adds the fallback it builds for each method. Not exported from the barrel: a fallback is defined by
// `@Fallback` on a method, never by name.
export const kAddFallback = Symbol('@caffeinejs/resilience:add-fallback')

/**
 * The presets one container shares: every method that names a preset gets the same instances, and so the same state.
 * Every instance is built when the registry is, so a bad option fails at start-up. Each is named after its preset, in
 * events and metrics alike: `registry.retry('inventory')` is the retry of preset `inventory`.
 *
 * The `Resilience()` feature builds and binds it; inject it to use the same instances by hand, or to instrument them.
 */
export class ResilienceRegistry {
  declare [Symbol.dispose]: () => void
  readonly #circuitBreakers = new Map<string, CircuitBreaker>()
  readonly #retries = new Map<string, Retry>()
  readonly #timeLimiters = new Map<string, TimeLimiter>()
  readonly #bulkheads = new Map<string, Bulkhead>()
  readonly #rateLimiters = new Map<string, RateLimiter>()
  readonly #fallbacks: Fallback[] = []

  readonly #presets = new Set<string>()

  /** @throws {@link ErrInvalidOption} when an instance's options are out of range. */
  constructor(definitions: ResilienceDefinitions = {}) {
    for (const [name, preset] of Object.entries(definitions)) {
      this.#presets.add(name)
      if (preset.circuitBreaker !== undefined) {
        this.#circuitBreakers.set(name, circuitBreaker({ ...preset.circuitBreaker, name }))
      }
      if (preset.retry !== undefined) {
        this.#retries.set(name, retry({ ...preset.retry, name }))
      }
      if (preset.timeLimiter !== undefined) {
        this.#timeLimiters.set(name, timeLimiter({ ...preset.timeLimiter, name }))
      }
      if (preset.bulkhead !== undefined) {
        this.#bulkheads.set(name, bulkhead({ ...preset.bulkhead, name }))
      }
      if (preset.rateLimiter !== undefined) {
        this.#rateLimiters.set(name, rateLimiter({ ...preset.rateLimiter, name }))
      }
    }
  }

  /** Whether preset `name` is defined, or, with `kind`, whether it defines a policy of that kind. */
  has(name: string, kind?: ResilienceKind): boolean {
    return kind === undefined ? this.#presets.has(name) : this.#of(kind).has(name)
  }

  /** @throws {@link ErrInvalidOption} when preset `name` defines no circuit breaker. */
  circuitBreaker(name: string): CircuitBreaker {
    return this.#find(this.#circuitBreakers, 'circuitBreaker', name)
  }

  /** @throws {@link ErrInvalidOption} when preset `name` defines no retry. */
  retry(name: string): Retry {
    return this.#find(this.#retries, 'retry', name)
  }

  /** @throws {@link ErrInvalidOption} when preset `name` defines no time limiter. */
  timeLimiter(name: string): TimeLimiter {
    return this.#find(this.#timeLimiters, 'timeLimiter', name)
  }

  /** @throws {@link ErrInvalidOption} when preset `name` defines no bulkhead. */
  bulkhead(name: string): Bulkhead {
    return this.#find(this.#bulkheads, 'bulkhead', name)
  }

  /** @throws {@link ErrInvalidOption} when preset `name` defines no rate limiter. */
  rateLimiter(name: string): RateLimiter {
    return this.#find(this.#rateLimiters, 'rateLimiter', name)
  }

  circuitBreakers(): readonly CircuitBreaker[] {
    return [...this.#circuitBreakers.values()]
  }

  retries(): readonly Retry[] {
    return [...this.#retries.values()]
  }

  timeLimiters(): readonly TimeLimiter[] {
    return [...this.#timeLimiters.values()]
  }

  bulkheads(): readonly Bulkhead[] {
    return [...this.#bulkheads.values()]
  }

  rateLimiters(): readonly RateLimiter[] {
    return [...this.#rateLimiters.values()]
  }

  /** The fallback of every method that carries `@Fallback`, each named `Class.method`, once the application started. */
  fallbacks(): readonly Fallback[] {
    return [...this.#fallbacks]
  }

  [kAddFallback](fallback: Fallback): void {
    this.#fallbacks.push(fallback)
  }

  /**
   * Disposes every instance it holds, so no wait outlives a shutdown: a sleeping retry and a call waiting for a slot or
   * a permit end at once. `Resilience()` calls it when the application shuts down. The `[Symbol.dispose]` alias does
   * the same.
   */
  dispose(): void {
    for (const breaker of this.#circuitBreakers.values()) {
      breaker.dispose()
    }
    for (const retry of this.#retries.values()) {
      retry.dispose()
    }
    for (const pool of this.#bulkheads.values()) {
      pool.dispose()
    }
    for (const limiter of this.#rateLimiters.values()) {
      limiter.dispose()
    }
  }

  #of(kind: ResilienceKind): Map<string, unknown> {
    switch (kind) {
      case 'circuitBreaker':
        return this.#circuitBreakers
      case 'retry':
        return this.#retries
      case 'timeLimiter':
        return this.#timeLimiters
      case 'bulkhead':
        return this.#bulkheads
      case 'rateLimiter':
        return this.#rateLimiters
    }
  }

  #find<S>(instances: Map<string, S>, kind: ResilienceKind, name: string): S {
    const instance = instances.get(name)
    if (instance === undefined) {
      throw new ErrInvalidOption(
        errMessage(
          this.#presets.has(name)
            ? `Cannot find the ${LABELS[kind]} of preset "${name}": the preset defines no ${LABELS[kind]}`
            : `Cannot find the ${LABELS[kind]} of preset "${name}": no preset by that name is defined`,
        )
          .solutions(`Define it with Resilience(r => r.preset('${name}', p => p.${kind}({ ... })))`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    return instance
  }
}

disposable(ResilienceRegistry)

/** How the registry names a kind in messages, such as `circuit breaker`. */
export function labelOf(kind: ResilienceKind): string {
  return LABELS[kind]
}
