import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrBulkheadFull } from '../bulkhead/bulkhead.js'
import { CircuitBreaker } from '../circuitbreaker/circuitbreaker.js'
import { fakeTimersClock } from '../clock.testkit.js'
import { run } from '../compose.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrRateLimitExceeded } from '../ratelimiter/ratelimiter.js'
import { Retry } from '../retry/retry.js'
import { ResilienceRegistry } from './registry.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('ResilienceRegistry', () => {
  it('builds one instance per name and kind, named after its key', () => {
    const registry = new ResilienceRegistry({
      circuitBreakers: { inventory: { failureRateThreshold: 50 } },
      retries: { inventory: { maxAttempts: 2 } },
      timeLimiters: { inventory: { timeoutDuration: 2 * Second } },
      bulkheads: { payments: { maxConcurrentCalls: 4 } },
      rateLimiters: { partner: { limitForPeriod: 10, limitRefreshPeriod: 1 * Second } },
    })

    expect(registry.circuitBreaker('inventory')).toBeInstanceOf(CircuitBreaker)
    expect(registry.circuitBreaker('inventory').name).toBe('inventory')
    expect(registry.retry('inventory')).toBeInstanceOf(Retry)
    expect(registry.timeLimiter('inventory').name).toBe('inventory')
    expect(registry.bulkhead('payments').metrics().maxAllowedConcurrentCalls).toBe(4)
    expect(registry.rateLimiter('partner').metrics().availablePermissions).toBe(10)
  })

  // One name, one state: two lookups must reach the same breaker, or neither would see the other's failures.
  it('hands back the same instance on every lookup', () => {
    const registry = new ResilienceRegistry({ circuitBreakers: { inventory: {} } })

    expect(registry.circuitBreaker('inventory')).toBe(registry.circuitBreaker('inventory'))
  })

  it('keeps instances of the same name and different kinds apart', () => {
    const registry = new ResilienceRegistry({ circuitBreakers: { inventory: {} }, retries: { inventory: {} } })

    expect(registry.has('circuitBreaker', 'inventory')).toBe(true)
    expect(registry.has('retry', 'inventory')).toBe(true)
    expect(registry.has('bulkhead', 'inventory')).toBe(false)
  })

  it('refuses a lookup for a name nothing defines', () => {
    const registry = new ResilienceRegistry()

    expect(() => registry.circuitBreaker('payment')).toThrow(ErrInvalidOption)
    expect(() => registry.circuitBreaker('payment')).toThrow(
      'Cannot find circuit breaker "payment": no circuit breaker by that name is defined',
    )
    expect(() => registry.rateLimiter('partner')).toThrow(
      'Cannot find rate limiter "partner": no rate limiter by that name is defined',
    )
  })

  // Built when the registry is, so a bad option fails at start-up, not on the first call that reaches it.
  it('refuses a bad option when it is built, naming the instance', () => {
    expect(() => new ResilienceRegistry({ timeLimiters: { inventory: { timeoutDuration: 0 } } })).toThrow(
      'Cannot create time limiter "inventory": timeoutDuration must be a finite Duration greater than 0s, got 0s',
    )
  })

  it('lists the instances of each kind', () => {
    const registry = new ResilienceRegistry({ circuitBreakers: { a: {}, b: {} }, retries: { a: {} } })

    expect(registry.circuitBreakers().map(breaker => breaker.name)).toEqual(['a', 'b'])
    expect(registry.retries().map(retries => retries.name)).toEqual(['a'])
    expect(registry.timeLimiters()).toEqual([])
    expect(registry.bulkheads()).toEqual([])
    expect(registry.rateLimiters()).toEqual([])
    expect(registry.fallbacks()).toEqual([])
  })

  // At shutdown nothing may keep waiting: every queued call ends with its refusal, and no breaker timer stays set.
  it('disposes every instance it holds', async () => {
    vi.useFakeTimers()
    const registry = new ResilienceRegistry({
      circuitBreakers: { inventory: { automaticTransitionFromOpenToHalfOpen: true, clock: fakeTimersClock } },
      bulkheads: { payments: { maxConcurrentCalls: 1, maxWaitDuration: 10 * Second, clock: fakeTimersClock } },
      rateLimiters: {
        partner: {
          limitForPeriod: 1,
          limitRefreshPeriod: 10 * Second,
          maxWaitDuration: 10 * Second,
          clock: fakeTimersClock,
        },
      },
    })
    const held = Promise.withResolvers<string>()
    void run(registry.bulkhead('payments').wrap(() => held.promise))
    const queued = run(registry.bulkhead('payments').wrap(async () => 'ok')).catch((error: unknown) => error)
    await run(registry.rateLimiter('partner').wrap(async () => 'ok'))
    const throttled = run(registry.rateLimiter('partner').wrap(async () => 'ok')).catch((error: unknown) => error)
    registry.circuitBreaker('inventory').transitionToOpen()

    registry.dispose()

    expect(await queued).toBeInstanceOf(ErrBulkheadFull)
    expect(await throttled).toBeInstanceOf(ErrRateLimitExceeded)
    expect(vi.getTimerCount()).toBe(0)
  })
})
