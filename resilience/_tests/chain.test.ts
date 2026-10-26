import { Hour, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bulkhead } from '../bulkhead/bulkhead.js'
import { circuitBreaker, ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { compose } from '../compose.js'
import { ErrCallRefused } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { ErrRateLimitExceeded, rateLimiter } from '../ratelimiter/ratelimiter.js'
import { retry } from '../retry/retry.js'
import { timeLimiter } from '../timelimiter/timelimiter.js'

beforeEach(() => {
  useFakeClock()
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
  })
  const retries = retry({ name: 'inventory', maxAttempts: 3, backoff: 0 })
  const quota = rateLimiter({
    name: 'inventory',
    limitForPeriod: options.limitForPeriod ?? 100,
    limitRefreshPeriod: 1 * Hour,
  })
  const deadline = timeLimiter({ name: 'inventory', timeoutDuration: 1 * Second })
  const pool = bulkhead({ name: 'inventory', maxConcurrentCalls: 10 })
  return { breaker, retries, quota, run: compose(retries, breaker, quota, pool, deadline) }
}

describe('the recommended order', () => {
  it('runs the operation once per attempt, each attempt through every strategy', async () => {
    const { breaker, quota, run } = chain()
    let attempts = 0

    await expect(
      run(() => {
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

  // An open breaker inside a retry fails the call at once: retrying a refusal would only add load.
  it('fails at once, without another attempt, once the breaker inside the retry opens', async () => {
    const { breaker, retries, run } = chain()
    let attempts = 0
    const failing = () => {
      attempts++
      throw new Error('down')
    }

    const error = await run(failing).catch((reason: unknown) => reason)

    expect(attempts).toBe(2)
    expect(breaker.state).toBe('open')
    expect(error).toBeInstanceOf(ErrCallNotPermitted)
    expect(retries.metrics().failedCallsWithRetry).toBe(1)
  })

  // A spent quota or a full bulkhead is this process turning calls away, not the dependency failing: counted as
  // failures, a burst would open the breaker and refuse every call to a healthy dependency for the whole open wait.
  it('keeps the breaker closed when the strategies inside it refuse calls', async () => {
    const { breaker, run } = chain({ limitForPeriod: 1 })

    await expect(run(() => 'ok')).resolves.toBe('ok')
    const refusals = await Promise.all(
      [run(() => 'ok'), run(() => 'ok'), run(() => 'ok')].map(call => call.catch((error: unknown) => error)),
    )

    expect(refusals.every(error => error instanceof ErrRateLimitExceeded)).toBe(true)
    expect(refusals.every(error => error instanceof ErrCallRefused)).toBe(true)
    expect(breaker.state).toBe('closed')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 1, failedCalls: 0 })
  })

  // Node keeps 10 frames by default: every frame between the caller and the operation is one the caller's stack loses.
  it('adds at most 2n + 1 frames across all five strategies', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      const operationThatThrows = (): never => {
        throw new Error('sync')
      }
      const run = compose(
        retry({ name: 'inventory', maxAttempts: 1 }),
        circuitBreaker({ name: 'inventory' }),
        rateLimiter({ name: 'inventory', limitForPeriod: 100, limitRefreshPeriod: 1 * Second }),
        bulkhead({ name: 'inventory' }),
        timeLimiter({ name: 'inventory', timeoutDuration: 100 * Millisecond }),
      )
      function callsTheChain(): Promise<unknown> {
        return run(operationThatThrows)
      }

      const error = (await callsTheChain().catch((reason: unknown) => reason)) as Error
      const lines = error.stack?.split('\n') ?? []
      const operation = lines.findIndex(line => line.includes('operationThatThrows'))
      const entry = lines.findIndex(line => line.includes('callsTheChain'))

      expect(operation).toBeGreaterThan(0)
      expect(entry - operation - 1).toBeLessThanOrEqual(11)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})
