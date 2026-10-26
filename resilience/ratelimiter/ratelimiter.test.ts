import { getEventListeners } from 'node:events'

import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compose, runWith } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import type { ExecutionContext } from '../strategy.js'
import { ErrRateLimitExceeded, rateLimiter, type RateLimiterEvents, type RateLimiterOptions } from './ratelimiter.js'

beforeEach(() => {
  useFakeClock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function limiterOf(options: Partial<RateLimiterOptions> = {}) {
  return rateLimiter({
    name: 'partner-api',
    limitForPeriod: 2,
    limitRefreshPeriod: 1 * Millisecond * Second,
    ...options,
  })
}

// Records the time each call starts at.
function recorder() {
  const starts: Array<[string, number]> = []
  const operation = (id: string) => () => {
    starts.push([id, performance.now()])
    return id
  }
  return { starts, operation }
}

function listen<K extends keyof RateLimiterEvents>(
  target: { on: (type: K, listener: (event: RateLimiterEvents[K]) => unknown) => () => void },
  ...types: K[]
): Array<[K, RateLimiterEvents[K]]> {
  const seen: Array<[K, RateLimiterEvents[K]]> = []
  for (const type of types) {
    target.on(type, event => seen.push([type, event]))
  }
  return seen
}

describe('rate limiter options', () => {
  it.each([
    [{ limitForPeriod: 0 }, 'limitForPeriod must be an integer of at least 1, got 0'],
    [{ limitForPeriod: undefined }, 'limitForPeriod must be an integer of at least 1, got undefined'],
    [{ limitRefreshPeriod: 0 }, 'limitRefreshPeriod must be a finite Duration greater than 0s, got 0s'],
    [{ limitRefreshPeriod: undefined }, 'limitRefreshPeriod must be a finite Duration greater than 0s, got undefined'],
    [{ maxWaitDuration: -1 }, 'maxWaitDuration must be a finite Duration of at least 0s, got -1ms'],
    [{ captureStackTrace: 1 }, 'captureStackTrace must be a boolean, got number'],
  ])('refuses %o when it is created, naming it', (options, reason) => {
    const create = () => limiterOf(options as object)

    expect(create).toThrow(ErrInvalidOption)
    expect(create).toThrow(`Cannot create rate limiter "partner-api": ${reason}`)
  })

  it('requires a name', () => {
    expect(() => rateLimiter({ name: '', limitForPeriod: 1, limitRefreshPeriod: 1 * Millisecond })).toThrow(
      'Cannot create rate limiter: name must be a non-empty string',
    )
  })

  it('exposes its name', () => {
    expect(limiterOf().name).toBe('partner-api')
  })
})

describe('rate limiter', () => {
  it('lets limitForPeriod calls start in a period, and refuses the next with the time left to the next one', async () => {
    const quota = limiterOf()
    const { starts, operation } = recorder()
    await vi.advanceTimersByTimeAsync(300)

    await runWith(operation('a'), quota)
    await runWith(operation('b'), quota)
    const refused = await runWith(operation('c'), quota).catch((error: unknown) => error)

    expect(starts.map(([id]) => id)).toEqual(['a', 'b'])
    expect(refused).toBeInstanceOf(ErrRateLimitExceeded)
    // The kind every refusal shares, which retry never retries and an HTTP layer answers with 503.
    expect(refused).toBeInstanceOf(ErrCallRefused)
    expect(refused).toMatchObject({
      rateLimiter: 'partner-api',
      retryAfter: 700,
      code: 'ERR_RATE_LIMIT_EXCEEDED',
      name: 'ErrRateLimitExceeded',
      message: expect.stringContaining('Cannot call "partner-api": rate limit of 2 calls per 1s reached'),
    })
    expect(quota.metrics()).toEqual({ availablePermissions: 0, waitingCalls: 0, rejectedCalls: 1 })
  })

  // Periods are counted from when the limiter was created, not from the first call, so a quota cannot drift.
  it('refreshes at each period boundary counted from its creation', async () => {
    const quota = limiterOf()
    const { operation } = recorder()
    await vi.advanceTimersByTimeAsync(900)
    await runWith(operation('a'), quota)
    await runWith(operation('b'), quota)

    await vi.advanceTimersByTimeAsync(99)
    await expect(runWith(operation('c'), quota)).rejects.toMatchObject({ retryAfter: 1 })
    await vi.advanceTimersByTimeAsync(1)

    await expect(runWith(operation('d'), quota)).resolves.toBe('d')
    expect(quota.metrics().availablePermissions).toBe(1)
  })

  it('makes a call wait for the next period when its permit comes within maxWaitDuration, first come first served', async () => {
    const quota = limiterOf({ maxWaitDuration: 1 * Millisecond * Second })
    const { starts, operation } = recorder()
    await vi.advanceTimersByTimeAsync(400)

    const calls = ['a', 'b', 'c', 'd'].map(id => runWith(operation(id), quota))
    expect(quota.metrics().waitingCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(599)
    expect(starts.map(([id]) => id)).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1)

    await expect(Promise.all(calls)).resolves.toEqual(['a', 'b', 'c', 'd'])
    expect(starts).toEqual([
      ['a', 400],
      ['b', 400],
      ['c', 1_000],
      ['d', 1_000],
    ])
  })

  it('spreads reservations over as many periods as the waiting calls need', async () => {
    const quota = limiterOf({ maxWaitDuration: 5 * Millisecond * Second })
    const { starts, operation } = recorder()

    const calls = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => runWith(operation(id), quota))
    await vi.advanceTimersByTimeAsync(3 * Second)
    await Promise.all(calls)

    expect(starts).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 1_000],
      ['d', 1_000],
      ['e', 2_000],
      ['f', 2_000],
      ['g', 3_000],
    ])
  })

  it('refuses a call whose permit lies further than maxWaitDuration, with retryAfter set to that wait', async () => {
    const quota = limiterOf({ maxWaitDuration: 1_500 * Millisecond })
    const { operation } = recorder()

    const waiting = ['a', 'b', 'c', 'd'].map(id => runWith(operation(id), quota))
    const refused = await runWith(operation('e'), quota).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrRateLimitExceeded)
    expect((refused as ErrRateLimitExceeded).retryAfter).toBe(2_000)
    expect(quota.metrics()).toMatchObject({ waitingCalls: 2, rejectedCalls: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all(waiting)
  })

  it('takes a waiting call out of line when its signal aborts, without delaying the calls behind it', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Millisecond * Second })
    const { starts, operation } = recorder()
    const caller = new AbortController()
    const reason = new Error('client left')

    await runWith(operation('a'), quota)
    const b = runWith(operation('b'), quota, caller.signal).catch((error: unknown) => error)
    const c = runWith(operation('c'), quota)
    caller.abort(reason)

    expect(await b).toBe(reason)
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
    expect(quota.metrics().waitingCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(2 * Second)
    await c
    expect(starts).toEqual([
      ['a', 0],
      ['c', 2_000],
    ])
  })

  // An aborted call's permit is spent rather than handed on: calls reserve by count, so handing it to a newcomer
  // would start two calls in a period that has room for one.
  it('never starts more than limitForPeriod calls in a period after a waiting call aborts', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Millisecond * Second })
    const { starts, operation } = recorder()
    const caller = new AbortController()

    await runWith(operation('a'), quota)
    const b = runWith(operation('b'), quota, caller.signal).catch(() => undefined)
    const c = runWith(operation('c'), quota)
    caller.abort()
    await b
    const d = runWith(operation('d'), quota)
    await vi.advanceTimersByTimeAsync(4 * Second)
    await Promise.all([c, d])

    const perPeriod = new Map<number, number>()
    for (const [, at] of starts) {
      const period = Math.floor(at / 1_000)
      perPeriod.set(period, (perPeriod.get(period) ?? 0) + 1)
    }
    expect([...perPeriod.values()].every(count => count === 1)).toBe(true)
  })

  // Nobody reserved after the last call in line, so its permit can go back exactly: the next call takes its place.
  it('hands the permit of the last call in line to the next call when it aborts', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 1_500 * Millisecond * Millisecond })
    const { starts, operation } = recorder()
    const caller = new AbortController()

    await runWith(operation('a'), quota)
    const b = runWith(operation('b'), quota, caller.signal).catch(() => undefined)
    caller.abort()
    await b
    const d = runWith(operation('d'), quota)
    await vi.advanceTimersByTimeAsync(1 * Second)
    await d

    expect(starts).toEqual([
      ['a', 0],
      ['d', 1_000],
    ])
  })

  it('leaves no timer behind when the only waiting call aborts', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Millisecond * Second })
    const caller = new AbortController()

    await runWith(() => 'a', quota)
    const b = runWith(() => 'b', quota, caller.signal).catch(() => undefined)
    expect(vi.getTimerCount()).toBe(1)
    caller.abort()
    await b

    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once, reserving nothing, when the caller’s signal has already aborted', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Millisecond * Second })
    const { starts, operation } = recorder()
    const caller = new AbortController()
    caller.abort(new Error('gone'))
    await runWith(operation('a'), quota)

    await expect(quota.run({ signal: caller.signal } as ExecutionContext, () => Promise.resolve('b'))).rejects.toThrow(
      'gone',
    )
    expect(quota.metrics().waitingCalls).toBe(0)
    // Had the aborted call reserved the next period's permit, this one would wait for the period after.
    const c = runWith(operation('c'), quota)
    await vi.advanceTimersByTimeAsync(1 * Second)
    await c
    expect(starts).toEqual([
      ['a', 0],
      ['c', 1_000],
    ])
  })

  it('runs no timer while nobody waits', async () => {
    const quota = limiterOf()

    await runWith(() => 'a', quota)
    await runWith(() => 'b', quota)
    await runWith(() => 'c', quota).catch(() => undefined)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports each call as it gets a permit or is refused', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 1 * Millisecond * Second })
    const seen = listen(quota, 'permitted', 'rejected')

    await runWith(() => 'a', quota)
    const b = runWith(() => 'b', quota)
    await runWith(() => 'c', quota).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1 * Second)
    await b

    expect(seen).toEqual([
      ['permitted', { name: 'partner-api', waited: 0 }],
      ['rejected', { name: 'partner-api', retryAfter: 2_000 }],
      ['permitted', { name: 'partner-api', waited: 1_000 }],
    ])
  })

  // The limit is process-wide: a refusal that left it at zero would strip the stack of every error that follows.
  it('restores Error.stackTraceLimit after a refusal', async () => {
    const quota = limiterOf({ limitForPeriod: 1 })
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    await runWith(() => 'a', quota)

    await runWith(() => 'b', quota).catch(() => undefined)

    expect(errorClass.stackTraceLimit).toBe(original)
  })

  it('refuses without a stack trace unless told to capture one', async () => {
    const quiet = limiterOf({ limitForPeriod: 1 })
    const loud = limiterOf({ limitForPeriod: 1, captureStackTrace: true })
    await runWith(() => 'a', quiet)
    await runWith(() => 'a', loud)

    const silent = (await runWith(() => 'b', quiet).catch((error: unknown) => error)) as Error
    const traced = (await runWith(() => 'b', loud).catch((error: unknown) => error)) as Error

    const frames = (error: Error) => error.stack?.split('\n').filter(line => /^\s+at /.test(line)) ?? []
    expect(frames(silent)).toEqual([])
    expect(frames(traced).length).toBeGreaterThan(0)
  })

  // Node keeps 10 frames by default: every frame between the caller and the operation is one the caller's stack loses.
  it('adds at most 2n + 1 frames between the caller and a synchronously throwing operation', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      const operationThatThrows = (): never => {
        throw new Error('sync')
      }
      const limited = compose(limiterOf())
      function callsTheRateLimiter(): Promise<unknown> {
        return limited(operationThatThrows)
      }

      const error = (await callsTheRateLimiter().catch((reason: unknown) => reason)) as Error
      const lines = error.stack?.split('\n') ?? []
      const operation = lines.findIndex(line => line.includes('operationThatThrows'))
      const entry = lines.findIndex(line => line.includes('callsTheRateLimiter'))

      expect(operation).toBeGreaterThan(0)
      expect(entry - operation - 1).toBeLessThanOrEqual(3)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})

// Timers fire late when the event loop is busy: a call that reserved a permit must still start before one that
// arrives after its period began.
describe('rate limiter on a busy event loop', () => {
  it('starts a call whose period has come before a call that arrives later', async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    const quota = rateLimiter({
      name: 'partner-api',
      limitForPeriod: 1,
      limitRefreshPeriod: 50 * Millisecond * Millisecond,
      maxWaitDuration: 1 * Millisecond * Second,
    })
    const order: string[] = []

    await runWith(() => order.push('a'), quota)
    const b = runWith(() => order.push('b'), quota)
    // Blocks the event loop past the period b reserved, so its timer cannot fire in time.
    const until = performance.now() + 120
    while (performance.now() < until) {
      // busy
    }
    const c = runWith(() => order.push('c'), quota)
    await Promise.all([b, c])

    expect(order).toEqual(['a', 'b', 'c'])
  })
})
