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
  it('builds each policy a preset defines, named after the preset', () => {
    const registry = new ResilienceRegistry({
      inventory: {
        circuitBreaker: { failureRateThreshold: 50 },
        retry: { maxAttempts: 2 },
        timeLimiter: { timeoutDuration: 2 * Second },
      },
      payments: { bulkhead: { maxConcurrentCalls: 4 } },
      partner: { rateLimiter: { limitForPeriod: 10, limitRefreshPeriod: 1 * Second } },
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
    const registry = new ResilienceRegistry({ inventory: { circuitBreaker: {} } })

    expect(registry.circuitBreaker('inventory')).toBe(registry.circuitBreaker('inventory'))
  })

  it('tells which presets exist and which policies each defines', () => {
    const registry = new ResilienceRegistry({ inventory: { circuitBreaker: {}, retry: {} } })

    expect(registry.has('inventory')).toBe(true)
    expect(registry.has('inventory', 'circuitBreaker')).toBe(true)
    expect(registry.has('inventory', 'retry')).toBe(true)
    expect(registry.has('inventory', 'bulkhead')).toBe(false)
    expect(registry.has('payments')).toBe(false)
  })

  it('refuses a lookup for a preset nothing defines, or a policy the preset lacks', () => {
    const registry = new ResilienceRegistry({ inventory: { retry: {} } })

    expect(() => registry.circuitBreaker('payment')).toThrow(ErrInvalidOption)
    expect(() => registry.circuitBreaker('payment')).toThrow(
      'Cannot find the circuit breaker of preset "payment": no preset by that name is defined',
    )
    expect(() => registry.rateLimiter('inventory')).toThrow(
      'Cannot find the rate limiter of preset "inventory": the preset defines no rate limiter',
    )
  })

  // Built when the registry is, so a bad option fails at start-up, not on the first call that reaches it.
  it('refuses a bad option when it is built, naming the instance', () => {
    expect(() => new ResilienceRegistry({ inventory: { timeLimiter: { timeoutDuration: 0 } } })).toThrow(
      'Cannot create time limiter "inventory": timeoutDuration must be a finite Duration greater than 0s, got 0s',
    )
  })

  it('lists the instances of each kind', () => {
    const registry = new ResilienceRegistry({ a: { circuitBreaker: {}, retry: {} }, b: { circuitBreaker: {} } })

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
      inventory: { circuitBreaker: { automaticTransitionFromOpenToHalfOpen: true, clock: fakeTimersClock } },
      payments: { bulkhead: { maxConcurrentCalls: 1, maxWaitDuration: 10 * Second, clock: fakeTimersClock } },
      partner: {
        rateLimiter: {
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
