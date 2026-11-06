import { Hour, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bulkhead } from '../bulkhead/bulkhead.js'
import { circuitBreaker } from '../circuitbreaker/circuitbreaker.js'
import { fakeTimersClock } from '../clock.testkit.js'
import { compose, run } from '../compose.js'
import { ErrCallRefused } from '../errors.js'
import { fallback } from '../fallback/fallback.js'
import type { Operation } from '../policy.js'
import { ErrRateLimitExceeded, rateLimiter } from '../ratelimiter/ratelimiter.js'
import { retry } from '../retry/retry.js'
import { timeLimiter } from '../timelimiter/timelimiter.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// retry(circuitBreaker(rateLimiter(bulkhead(timeLimiter(operation))))), the order the README recommends.
function chain(options: { limitForPeriod?: number } = {}) {
  const breaker = circuitBreaker({
    name: 'inventory',
    minimumNumberOfCalls: 2,
    slidingWindow: { type: 'count', size: 2 },
    clock: fakeTimersClock,
  })
  const retries = retry({ name: 'inventory', maxAttempts: 3, backoff: 0, clock: fakeTimersClock })
  const quota = rateLimiter({
    name: 'inventory',
    limitForPeriod: options.limitForPeriod ?? 100,
    limitRefreshPeriod: 1 * Hour,
    clock: fakeTimersClock,
  })
  const deadline = timeLimiter({ name: 'inventory', timeoutDuration: 1 * Second, clock: fakeTimersClock })
  const pool = bulkhead({ name: 'inventory', maxConcurrentCalls: 10, clock: fakeTimersClock })
  const guarded = compose(retries, breaker, quota, pool, deadline)
  return { breaker, retries, quota, call: <T>(op: Operation<T>): Promise<T> => run(guarded(op)) }
}

describe('the recommended order', () => {
  it('runs the operation once per attempt, each attempt through every strategy', async () => {
    const { breaker, quota, call } = chain()
    let attempts = 0

    await expect(
      call(async () => {
        attempts++
        if (attempts === 1) {
          throw new Error('blip')
        }
        return 'ok'
      }),
    ).resolves.toBe('ok')

    expect(attempts).toBe(2)
    expect(breaker.metrics().bufferedCalls).toBe(2)
    expect(quota.metrics().availablePermissions).toBe(98)
  })

  // An open breaker inside a retry fails the call at once: retrying a refusal would only add load. The caller gets the
  // last failure that reached the operation, not the refusal, which would claim no attempt ran.
  it('fails at once, without another attempt, once the breaker inside the retry opens', async () => {
    const { breaker, retries, call } = chain()
    let attempts = 0
    const failing = async () => {
      attempts++
      throw new Error('down')
    }

    const error = await call(failing).catch((reason: unknown) => reason)

    expect(attempts).toBe(2)
    expect(breaker.state).toBe('open')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('down')
    expect(retries.metrics().failedCallsWithRetry).toBe(1)
  })

  // A spent quota or a full bulkhead is this process turning calls away, not the dependency failing: counted as
  // failures, a burst would open the breaker and refuse every call to a healthy dependency for the whole open wait.
  it('keeps the breaker closed when the policies inside it refuse calls', async () => {
    const { breaker, call } = chain({ limitForPeriod: 1 })
    const ok = async () => 'ok'

    await expect(call(ok)).resolves.toBe('ok')
    const refusals = await Promise.all(
      [call(ok), call(ok), call(ok)].map(refused => refused.catch((error: unknown) => error)),
    )

    expect(refusals.every(error => error instanceof ErrRateLimitExceeded)).toBe(true)
    expect(refusals.every(error => error instanceof ErrCallRefused)).toBe(true)
    expect(breaker.state).toBe('closed')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 1, failedCalls: 0 })
  })

  // Node keeps 10 frames by default: every frame between the caller and the operation is one the caller's stack loses.
  it('adds one frame per policy and one lift across all five policies', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      function operationThatThrows(): never {
        throw new Error('sync')
      }
      const guarded = compose(
        retry({ name: 'inventory', maxAttempts: 1, clock: fakeTimersClock }),
        circuitBreaker({ name: 'inventory', clock: fakeTimersClock }),
        rateLimiter({ name: 'inventory', limitForPeriod: 100, limitRefreshPeriod: 1 * Second, clock: fakeTimersClock }),
        bulkhead({ name: 'inventory', clock: fakeTimersClock }),
        timeLimiter({ name: 'inventory', timeoutDuration: 100 * Millisecond, clock: fakeTimersClock }),
      )(operationThatThrows as () => Promise<never>)
      function callsTheChain(): Promise<unknown> {
        return guarded({ signal: undefined }, undefined)
      }

      const error = (await callsTheChain().catch((reason: unknown) => reason)) as Error
      const lines = error.stack?.split('\n') ?? []
      const operation = lines.findIndex(line => line.includes('operationThatThrows'))
      const entry = lines.findIndex(line => line.includes('callsTheChain'))

      expect(operation).toBeGreaterThan(0)
      expect(entry - operation - 1).toBe(6)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})

describe('a client error through every policy', () => {
  class ErrNotFound extends Error {}

  // An entrypoint's transport marks the client's own errors on the context; every policy on the way out must let
  // them through untouched, so the client's answer is the one the handler gave.
  it('runs the operation once, records the error nowhere and hands it to the caller unchanged', async () => {
    const { breaker, retries, quota } = chain()
    const handler = vi.fn(() => 'cached')
    const recovery = fallback(handler, { name: 'inventory' })
    const missing = new ErrNotFound('no such record')
    const operation = vi.fn(async () => {
      throw missing
    })
    const pool = bulkhead({ name: 'inventory', maxConcurrentCalls: 10, clock: fakeTimersClock })
    const deadline = timeLimiter({ name: 'inventory', timeoutDuration: 1 * Second, clock: fakeTimersClock })
    const guarded = compose(recovery, retries, breaker, quota, pool, deadline)(operation)

    const error = await guarded(
      { signal: undefined, isClientError: thrown => thrown instanceof ErrNotFound },
      undefined,
    ).catch((thrown: unknown) => thrown)

    expect(error).toBe(missing)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 0, failedCalls: 0 })
    expect(recovery.metrics()).toMatchObject({ recoveredCalls: 0 })
  })
})
