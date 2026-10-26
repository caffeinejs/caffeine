import { errMessage } from '@caffeinejs/std/err'

import { type Bulkhead, bulkhead, type BulkheadOptions } from '../bulkhead/bulkhead.js'
import { type CircuitBreaker, circuitBreaker, type CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import { ErrInvalidOption } from '../errors.js'
import type { Fallback } from '../fallback/fallback.js'
import { type RateLimiter, rateLimiter, type RateLimiterOptions } from '../ratelimiter/ratelimiter.js'
import { type Retry, retry, type RetryOptions } from '../retry/retry.js'
import { type TimeLimiter, timeLimiter, type TimeLimiterOptions } from '../timelimiter/timelimiter.js'

/** The options of each named instance, by kind. The name is the record key. */
export interface ResilienceDefinitions {
  readonly circuitBreakers?: Readonly<Record<string, Omit<CircuitBreakerOptions, 'name'>>>
  readonly retries?: Readonly<Record<string, Omit<RetryOptions, 'name'>>>
  readonly timeLimiters?: Readonly<Record<string, Omit<TimeLimiterOptions, 'name'>>>
  readonly bulkheads?: Readonly<Record<string, Omit<BulkheadOptions, 'name'>>>
  readonly rateLimiters?: Readonly<Record<string, Omit<RateLimiterOptions, 'name'>>>
}

/** A kind of named instance the registry holds. */
export type ResilienceKind = 'circuitBreaker' | 'retry' | 'timeLimiter' | 'bulkhead' | 'rateLimiter'

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
 * The named strategies one container shares: every method that names an instance gets the same one, and so the
 * same state. Every instance is built when the registry is, so a bad option fails at start-up.
 *
 * The `Resilience()` feature builds and binds it; inject it to use the same instances by hand, or to instrument them.
 */
export class ResilienceRegistry {
  readonly #circuitBreakers = new Map<string, CircuitBreaker>()
  readonly #retries = new Map<string, Retry>()
  readonly #timeLimiters = new Map<string, TimeLimiter>()
  readonly #bulkheads = new Map<string, Bulkhead>()
  readonly #rateLimiters = new Map<string, RateLimiter>()
  readonly #fallbacks: Fallback[] = []

  /** @throws {@link ErrInvalidOption} when an instance's options are out of range. */
  constructor(definitions: ResilienceDefinitions = {}) {
    for (const [name, options] of Object.entries(definitions.circuitBreakers ?? {})) {
      this.#circuitBreakers.set(name, circuitBreaker({ ...options, name }))
    }
    for (const [name, options] of Object.entries(definitions.retries ?? {})) {
      this.#retries.set(name, retry({ ...options, name }))
    }
    for (const [name, options] of Object.entries(definitions.timeLimiters ?? {})) {
      this.#timeLimiters.set(name, timeLimiter({ ...options, name }))
    }
    for (const [name, options] of Object.entries(definitions.bulkheads ?? {})) {
      this.#bulkheads.set(name, bulkhead({ ...options, name }))
    }
    for (const [name, options] of Object.entries(definitions.rateLimiters ?? {})) {
      this.#rateLimiters.set(name, rateLimiter({ ...options, name }))
    }
  }

  /** Whether an instance of that kind and name is defined. */
  has(kind: ResilienceKind, name: string): boolean {
    return this.#of(kind).has(name)
  }

  /** @throws {@link ErrInvalidOption} when no circuit breaker of that name is defined. */
  circuitBreaker(name: string): CircuitBreaker {
    return this.#find(this.#circuitBreakers, 'circuitBreaker', name)
  }

  /** @throws {@link ErrInvalidOption} when no retry of that name is defined. */
  retry(name: string): Retry {
    return this.#find(this.#retries, 'retry', name)
  }

  /** @throws {@link ErrInvalidOption} when no time limiter of that name is defined. */
  timeLimiter(name: string): TimeLimiter {
    return this.#find(this.#timeLimiters, 'timeLimiter', name)
  }

  /** @throws {@link ErrInvalidOption} when no bulkhead of that name is defined. */
  bulkhead(name: string): Bulkhead {
    return this.#find(this.#bulkheads, 'bulkhead', name)
  }

  /** @throws {@link ErrInvalidOption} when no rate limiter of that name is defined. */
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
        errMessage(`Cannot find ${LABELS[kind]} "${name}": no ${LABELS[kind]} by that name is defined`)
          .solutions(`Define it with Resilience(r => r.${kind}('${name}', { ... }))`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    return instance
  }
}

/** How the registry names a kind in messages, such as `circuit breaker`. */
export function labelOf(kind: ResilienceKind): string {
  return LABELS[kind]
}
