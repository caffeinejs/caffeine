import { Millisecond } from '@caffeinejs/std/duration'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

import { runWith } from '../compose.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { ErrRateLimitExceeded, rateLimiter } from './ratelimiter.js'

beforeEach(() => {
  useFakeClock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Arrivals packed into a few periods, many of them giving up while they wait: the schedules where a quota breaks.
const arrival = fc.record({
  at: fc.integer({ min: 0, max: 1_500 }),
  abortAfter: fc.option(fc.integer({ min: 0, max: 800 }), { nil: undefined, freq: 2 }),
})

describe('rate limiter (property)', () => {
  // A partner's quota is a contract: whatever the arrivals and the aborts, no period may see more starts than the
  // limit, no call may wait longer than it was allowed to, and every refusal must say when to come back.
  it.prop(
    [
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 50, max: 400 }),
      fc.integer({ min: 0, max: 2_000 }),
      fc.array(arrival, { minLength: 1, maxLength: 60 }),
    ],
    { numRuns: 300 },
  )('holds its quota, its wait bound and its retryAfter', async (limitForPeriod, period, maxWait, arrivals) => {
    vi.clearAllTimers()
    const origin = performance.now()
    const quota = rateLimiter({
      name: 'partner-api',
      limitForPeriod,
      limitRefreshPeriod: period * Millisecond,
      maxWaitDuration: maxWait * Millisecond,
    })
    const startsPerPeriod = new Map<number, number>()
    const waits: number[] = []
    const retryAfters: number[] = []
    const violations: string[] = []

    for (const { at, abortAfter } of arrivals) {
      setTimeout(() => {
        const controller = new AbortController()
        if (abortAfter !== undefined) {
          setTimeout(() => controller.abort(), abortAfter)
        }
        const arrived = performance.now()
        const before = quota.metrics()
        let started = false
        runWith(
          () => {
            started = true
            const now = performance.now()
            const cycle = Math.floor((now - origin) / period)
            startsPerPeriod.set(cycle, (startsPerPeriod.get(cycle) ?? 0) + 1)
            waits.push(now - arrived)
          },
          quota,
          controller.signal,
        ).catch((error: unknown) => {
          if (error instanceof ErrRateLimitExceeded) {
            retryAfters.push(error.retryAfter)
          }
        })
        if (before.availablePermissions > 0 && before.waitingCalls === 0 && !controller.signal.aborted && !started) {
          violations.push(`a call at ${arrived} found a permit and nobody waiting, and did not start`)
        }
      }, at)
    }

    await vi.advanceTimersByTimeAsync(1_500 + maxWait + period)

    expect(Math.max(...startsPerPeriod.values(), 0)).toBeLessThanOrEqual(limitForPeriod)
    expect(Math.max(...waits, 0)).toBeLessThanOrEqual(maxWait)
    // A refusal means the permit lay further than the call may wait.
    expect(retryAfters.every(retryAfter => retryAfter > maxWait)).toBe(true)
    expect(violations).toEqual([])
    expect(quota.metrics().waitingCalls).toBe(0)
  })
})
