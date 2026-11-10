import { getEventListeners } from 'node:events'

import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeTimersClock } from '../clock.testkit.js'
import { compose, run } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import type { CallContext } from '../policy.js'
import { restoring } from '../restoring.testkit.js'
import { unhandledRejections } from '../unhandled.testkit.js'
import { ErrRateLimitExceeded, rateLimiter, type RateLimiterEvents, type RateLimiterOptions } from './ratelimiter.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function limiterOf(options: Partial<RateLimiterOptions> = {}) {
  return rateLimiter({
    name: 'partner-api',
    limitForPeriod: 2,
    limitRefreshPeriod: 1 * Second,
    clock: fakeTimersClock,
    ...options,
  })
}

// Records the time each call starts at.
function recorder() {
  const starts: Array<[string, number]> = []
  const operation = (id: string) => async () => {
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

    await run(quota.wrap(operation('a')))
    await run(quota.wrap(operation('b')))
    const refused = await run(quota.wrap(operation('c'))).catch((error: unknown) => error)

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
    await run(quota.wrap(operation('a')))
    await run(quota.wrap(operation('b')))

    await vi.advanceTimersByTimeAsync(99)
    await expect(run(quota.wrap(operation('c')))).rejects.toMatchObject({ retryAfter: 1 })
    await vi.advanceTimersByTimeAsync(1)

    await expect(run(quota.wrap(operation('d')))).resolves.toBe('d')
    expect(quota.metrics().availablePermissions).toBe(1)
  })

  it('makes a call wait for the next period when its permit comes within maxWaitDuration, first come first served', async () => {
    const quota = limiterOf({ maxWaitDuration: 1 * Second })
    const { starts, operation } = recorder()
    await vi.advanceTimersByTimeAsync(400)

    const calls = ['a', 'b', 'c', 'd'].map(id => run(quota.wrap(operation(id))))
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
    const quota = limiterOf({ maxWaitDuration: 5 * Second })
    const { starts, operation } = recorder()

    const calls = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => run(quota.wrap(operation(id))))
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

    const waiting = ['a', 'b', 'c', 'd'].map(id => run(quota.wrap(operation(id))))
    const refused = await run(quota.wrap(operation('e'))).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrRateLimitExceeded)
    expect((refused as ErrRateLimitExceeded).retryAfter).toBe(2_000)
    expect(quota.metrics()).toMatchObject({ waitingCalls: 2, rejectedCalls: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all(waiting)
  })

  it('takes a waiting call out of line when its signal aborts, without delaying the calls behind it', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { starts, operation } = recorder()
    const caller = new AbortController()
    const reason = new Error('client left')

    await run(quota.wrap(operation('a')))
    const b = run(quota.wrap(operation('b')), caller.signal).catch((error: unknown) => error)
    const c = run(quota.wrap(operation('c')))
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
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { starts, operation } = recorder()
    const caller = new AbortController()

    await run(quota.wrap(operation('a')))
    const b = run(quota.wrap(operation('b')), caller.signal).catch(() => undefined)
    const c = run(quota.wrap(operation('c')))
    caller.abort()
    await b
    const d = run(quota.wrap(operation('d')))
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
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 1_500 * Millisecond })
    const { starts, operation } = recorder()
    const caller = new AbortController()

    await run(quota.wrap(operation('a')))
    const b = run(quota.wrap(operation('b')), caller.signal).catch(() => undefined)
    caller.abort()
    await b
    const d = run(quota.wrap(operation('d')))
    await vi.advanceTimersByTimeAsync(1 * Second)
    await d

    expect(starts).toEqual([
      ['a', 0],
      ['d', 1_000],
    ])
  })

  it('leaves no timer behind when the only waiting call aborts', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const caller = new AbortController()

    await run(quota.wrap(async () => 'a'))
    const b = run(
      quota.wrap(async () => 'b'),
      caller.signal,
    ).catch(() => undefined)
    expect(vi.getTimerCount()).toBe(1)
    caller.abort()
    await b

    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once, reserving nothing, when the caller’s signal has already aborted', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { starts, operation } = recorder()
    const caller = new AbortController()
    caller.abort(new Error('gone'))
    await run(quota.wrap(operation('a')))

    await expect(quota.wrap(() => Promise.resolve('b'))({ signal: caller.signal }, undefined)).rejects.toThrow('gone')
    expect(quota.metrics().waitingCalls).toBe(0)
    // Had the aborted call reserved the next period's permit, this one would wait for the period after.
    const c = run(quota.wrap(operation('c')))
    await vi.advanceTimersByTimeAsync(1 * Second)
    await c
    expect(starts).toEqual([
      ['a', 0],
      ['c', 1_000],
    ])
  })

  it('runs no timer while nobody waits', async () => {
    const quota = limiterOf()

    await run(quota.wrap(async () => 'a'))
    await run(quota.wrap(async () => 'b'))
    await run(quota.wrap(async () => 'c')).catch(() => undefined)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports each call as it gets a permit or is refused', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 1 * Second })
    const seen = listen(quota, 'permitted', 'rejected')

    await run(quota.wrap(async () => 'a'))
    const b = run(quota.wrap(async () => 'b'))
    await run(quota.wrap(async () => 'c')).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1 * Second)
    await b

    expect(seen).toEqual([
      ['permitted', { name: 'partner-api', waited: 0 }],
      ['rejected', { name: 'partner-api', retryAfter: 2_000 }],
      ['permitted', { name: 'partner-api', waited: 1_000 }],
    ])
  })

  it('says the rate limiter was disposed in a refusal that captured a stack trace too', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second, captureStackTrace: true })
    await run(quota.wrap(async () => 'a'))
    const waiting = run(quota.wrap(async () => 'b')).catch((error: unknown) => error)

    quota.dispose()

    expect(((await waiting) as Error).message).toContain('rate limiter was disposed while the call waited for a permit')
  })

  // The limit is process-wide: a refusal that changed it would change the stack of every error that follows.
  it('leaves Error.stackTraceLimit as it found it after a refusal', async () => {
    const quota = limiterOf({ limitForPeriod: 1 })
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    await run(quota.wrap(async () => 'a'))

    await run(quota.wrap(async () => 'b')).catch(() => undefined)

    expect(errorClass.stackTraceLimit).toBe(original)
  })

  it('refuses without a stack trace unless told to capture one', async () => {
    const quiet = limiterOf({ limitForPeriod: 1 })
    const loud = limiterOf({ limitForPeriod: 1, captureStackTrace: true })
    await run(quiet.wrap(async () => 'a'))
    await run(loud.wrap(async () => 'a'))

    const silent = (await run(quiet.wrap(async () => 'b')).catch((error: unknown) => error)) as Error
    const traced = (await run(loud.wrap(async () => 'b')).catch((error: unknown) => error)) as Error

    const frames = (error: Error) => error.stack?.split('\n').filter(line => /^\s+at /.test(line)) ?? []
    expect(frames(silent)).toEqual([])
    expect(frames(traced).length).toBeGreaterThan(0)
  })

  // Node keeps 10 frames by default: every frame between the caller and the operation is one the caller's stack loses.
  it('adds two frames, its own and the lift, between the caller and a synchronously throwing operation', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      function operationThatThrows(): never {
        throw new Error('sync')
      }
      const limited = limiterOf().wrap(operationThatThrows as () => Promise<never>)
      function callsTheRateLimiter(): Promise<unknown> {
        return limited({ signal: undefined }, undefined)
      }

      const error = (await callsTheRateLimiter().catch((reason: unknown) => reason)) as Error
      const lines = error.stack?.split('\n') ?? []
      const operation = lines.findIndex(line => line.includes('operationThatThrows'))
      const entry = lines.findIndex(line => line.includes('callsTheRateLimiter'))

      expect(operation).toBeGreaterThan(0)
      expect(entry - operation - 1).toBe(2)
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
      limitRefreshPeriod: 50 * Millisecond,
      maxWaitDuration: 1 * Second,
    })
    const order: string[] = []

    await run(quota.wrap(async () => order.push('a')))
    const b = run(quota.wrap(async () => order.push('b')))
    // Blocks the event loop past the period b reserved, so its timer cannot fire in time.
    const until = performance.now() + 120
    while (performance.now() < until) {
      // busy
    }
    const c = run(quota.wrap(async () => order.push('c')))
    await Promise.all([b, c])

    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('rate limiter, changing its limits', () => {
  // A partner that lowers its quota mid-day must not see the period already under way change its count.
  it('applies a new limitForPeriod from the next period, leaving the current one its permits', async () => {
    const quota = limiterOf({ limitForPeriod: 2 })
    const { starts, operation } = recorder()
    await run(quota.wrap(operation('a')))

    quota.changeLimitForPeriod(5)

    await run(quota.wrap(operation('b')))
    expect(await run(quota.wrap(operation('c'))).catch((error: unknown) => error)).toBeInstanceOf(ErrRateLimitExceeded)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all(['d', 'e', 'f', 'g', 'h'].map(id => run(quota.wrap(operation(id)))))
    expect(await run(quota.wrap(operation('i'))).catch((error: unknown) => error)).toBeInstanceOf(ErrRateLimitExceeded)
    expect(starts.map(([id, at]) => `${id}@${at}`)).toEqual([
      'a@0',
      'b@0',
      'd@1000',
      'e@1000',
      'f@1000',
      'g@1000',
      'h@1000',
    ])
  })

  // Calls that reserved a period under the old limit would otherwise start more calls in it than the new one allows.
  it('lines the waiting calls up again under a lower limit, refusing those that would now wait too long', async () => {
    const quota = limiterOf({ limitForPeriod: 2, maxWaitDuration: 2 * Second })
    const { starts, operation } = recorder()
    const calls = ['a', 'b', 'c', 'd', 'e', 'f'].map(id =>
      run(quota.wrap(operation(id))).catch((error: unknown) => error),
    )
    expect(quota.metrics().waitingCalls).toBe(4)

    quota.changeLimitForPeriod(1)

    expect(quota.metrics()).toMatchObject({ waitingCalls: 2, rejectedCalls: 2 })
    await vi.advanceTimersByTimeAsync(2 * Second)
    const outcomes = await Promise.all(calls)
    expect(outcomes.slice(0, 4)).toEqual(['a', 'b', 'c', 'd'])
    // Once e is refused, f would take its place in the third period, still past its wait.
    expect(outcomes.slice(4).map(error => (error as ErrRateLimitExceeded).retryAfter)).toEqual([3_000, 3_000])
    expect(starts.map(([id, at]) => `${id}@${at}`)).toEqual(['a@0', 'b@0', 'c@1000', 'd@2000'])
  })

  // A listener may shut the rate limiter down from a refusal; the change must not refuse a call twice, or count a call
  // the shutdown already refused as holding a later permit.
  it('counts each refusal once when a rejected listener disposes the rate limiter during a change', async () => {
    const quota = limiterOf({ limitForPeriod: 2, maxWaitDuration: 1_500 * Millisecond })
    const { operation } = recorder()
    const early = ['a', 'b', 'c', 'd'].map(id => run(quota.wrap(operation(id))).catch((error: unknown) => error))
    await vi.advanceTimersByTimeAsync(600)
    const late = ['e', 'f'].map(id => run(quota.wrap(operation(id))).catch((error: unknown) => error))
    let rejected = 0
    quota.on('rejected', () => {
      if (++rejected === 1) {
        quota.dispose()
      }
    })

    quota.changeLimitForPeriod(1)

    const outcomes = await Promise.all([...early, ...late])
    expect(outcomes.slice(0, 2)).toEqual(['a', 'b'])
    expect(outcomes.slice(2).every(error => error instanceof ErrRateLimitExceeded)).toBe(true)
    expect(rejected).toBe(4)
    expect(quota.metrics()).toMatchObject({ waitingCalls: 0, rejectedCalls: 4 })
    await vi.advanceTimersByTimeAsync(400)
    expect(quota.metrics().availablePermissions).toBe(1)
  })

  it('moves the waiting calls forward under a higher limit', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { starts, operation } = recorder()
    const calls = ['a', 'b', 'c', 'd'].map(id => run(quota.wrap(operation(id))))

    quota.changeLimitForPeriod(3)
    await vi.advanceTimersByTimeAsync(1 * Second)

    await Promise.all(calls)
    expect(starts.map(([id, at]) => `${id}@${at}`)).toEqual(['a@0', 'b@1000', 'c@1000', 'd@1000'])
    const e = run(quota.wrap(operation('e')))
    await vi.advanceTimersByTimeAsync(1 * Second)
    await e
    expect(starts.at(-1)).toEqual(['e', 2_000])
  })

  it('lets a later call wait as long as a new maxWaitDuration allows, leaving waiting calls their permit', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 1 * Second })
    const { starts, operation } = recorder()
    const calls = ['a', 'b'].map(id => run(quota.wrap(operation(id))))

    quota.changeMaxWaitDuration(0)
    expect(await run(quota.wrap(operation('c'))).catch((error: unknown) => error)).toBeInstanceOf(ErrRateLimitExceeded)
    quota.changeMaxWaitDuration(5 * Second)
    expect(quota.maxWaitDuration).toBe(5 * Second)
    calls.push(run(quota.wrap(operation('d'))))
    await vi.advanceTimersByTimeAsync(2 * Second)

    await Promise.all(calls)
    expect(starts.map(([id, at]) => `${id}@${at}`)).toEqual(['a@0', 'b@1000', 'd@2000'])
  })

  it.each([
    [
      'limitForPeriod',
      (quota: ReturnType<typeof limiterOf>) => quota.changeLimitForPeriod(0),
      'an integer of at least 1, got 0',
    ],
    [
      'maxWaitDuration',
      (quota: ReturnType<typeof limiterOf>) => quota.changeMaxWaitDuration(-1),
      'a finite Duration of at least 0s, got -1ms',
    ],
  ])('refuses an invalid %s, keeping the one it had', (option, change, reason) => {
    const quota = limiterOf()

    expect(() => change(quota)).toThrow(ErrInvalidOption)
    expect(() => change(quota)).toThrow(`Cannot change rate limiter "partner-api": ${option} must be ${reason}`)
    expect(quota.metrics().availablePermissions).toBe(2)
  })
})

describe('rate limiter, dispose', () => {
  // A shutdown must not wait for the periods its waiting calls reserved.
  it('refuses every waiting call at once with the time its permit was away, leaving no timer', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { starts, operation } = recorder()
    await run(quota.wrap(operation('a')))
    const waiting = ['b', 'c'].map(id => run(quota.wrap(operation(id))).catch((error: unknown) => error))
    await vi.advanceTimersByTimeAsync(400)

    quota.dispose()

    const refused = (await Promise.all(waiting)) as ErrRateLimitExceeded[]
    expect(refused.map(error => error.retryAfter)).toEqual([600, 1_600])
    expect(refused.every(error => error instanceof ErrRateLimitExceeded)).toBe(true)
    expect(refused[0]!.message).toContain(
      'Cannot call "partner-api": rate limiter was disposed while the call waited for a permit',
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(quota.metrics()).toMatchObject({ waitingCalls: 0, rejectedCalls: 2 })
    expect(starts.map(([id]) => id)).toEqual(['a'])
  })

  // On a busy event loop the timer of a period can fire late; a call whose period has come holds its permit already.
  it('starts a waiting call whose period came while its timer was late, rather than refusing it', async () => {
    let late = 0
    const quota = limiterOf({
      limitForPeriod: 1,
      maxWaitDuration: 5 * Second,
      clock: { ...fakeTimersClock, now: () => performance.now() + late },
    })
    const { starts, operation } = recorder()
    await run(quota.wrap(operation('a')))
    const waiting = run(quota.wrap(operation('b')))
    await vi.advanceTimersByTimeAsync(999)
    late = 11

    quota.dispose()

    await expect(waiting).resolves.toBe('b')
    expect(starts.map(([id]) => id)).toEqual(['a', 'b'])
    expect(quota.metrics().rejectedCalls).toBe(0)
  })

  // A listener that reads the rate limiter while the shutdown refuses must see the shutdown done, not half of it.
  it('refuses the waiting calls only once none is left in line', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { operation } = recorder()
    await run(quota.wrap(operation('a')))
    const waiting = ['b', 'c'].map(id => run(quota.wrap(operation(id))).catch((error: unknown) => error))
    const seen: number[] = []
    quota.on('rejected', () => seen.push(quota.metrics().waitingCalls))

    quota.dispose()

    await Promise.all(waiting)
    expect(seen).toEqual([0, 0])
  })

  it('still starts a call that finds a permit, and refuses at once one that would wait', async () => {
    const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
    const { operation } = recorder()
    quota.dispose()

    await expect(run(quota.wrap(operation('a')))).resolves.toBe('a')
    const refused = await run(quota.wrap(operation('b'))).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrRateLimitExceeded)
    expect((refused as ErrRateLimitExceeded).retryAfter).toBe(1_000)
    // It never waited, so the limit is the reason.
    expect((refused as Error).message).toContain('Cannot call "partner-api": rate limit of 1 call per 1s reached')
    await vi.advanceTimersByTimeAsync(1 * Second)
    await expect(run(quota.wrap(operation('c')))).resolves.toBe('c')
  })

  it('is what a using declaration calls at the end of its block', async () => {
    const { operation } = recorder()
    let waiting: Promise<unknown> | undefined
    {
      using quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
      await run(quota.wrap(operation('a')))
      waiting = run(quota.wrap(operation('b'))).catch((error: unknown) => error)
    }

    expect(await waiting).toBeInstanceOf(ErrRateLimitExceeded)
  })
})

describe('rate limiter, unhandled rejections', () => {
  // Every way a call can end must settle the caller's promise and leave no other one rejected behind it.
  it('leaves no rejection unhandled, whichever way a call ends', async () => {
    const reasons = await unhandledRejections(async () => {
      const quota = limiterOf({ limitForPeriod: 1, maxWaitDuration: 2 * Second })
      const caller = new AbortController()
      const calls = [
        run(
          quota.wrap(async () => {
            throw new Error('down')
          }),
        ),
        run(
          quota.wrap(async () => 'aborted'),
          caller.signal,
        ),
        run(
          quota.wrap(async () => {
            throw new Error('down after waiting')
          }),
        ),
        run(quota.wrap(async () => 'refused when the limit drops')),
        run(quota.wrap(async () => 'refused at once')),
      ].map(call => call.catch(() => undefined))
      caller.abort()
      await vi.advanceTimersByTimeAsync(1 * Second)
      const disposed = limiterOf({ limitForPeriod: 1, maxWaitDuration: 5 * Second })
      calls.push(
        ...[run(disposed.wrap(async () => 'ok')), run(disposed.wrap(async () => 'disposed'))].map(call =>
          call.catch(() => undefined),
        ),
      )
      quota.changeLimitForPeriod(1)
      disposed.dispose()
      await vi.advanceTimersByTimeAsync(2 * Second)
      await Promise.all(calls)
    })

    expect(reasons).toEqual([])
  })
})

describe('a call that waited', () => {
  // Admitted from a timer and refused from the code that disposes the limiter, it runs, and its events are heard, in
  // its own caller's context: what the operation does and what a listener records belong to that caller's request.
  it('is admitted and refused through the restore() of its own context', async () => {
    const quota = limiterOf({ limitForPeriod: 1, limitRefreshPeriod: 100 * Millisecond, maxWaitDuration: 1 * Second })
    const { ctxOf, current } = restoring()
    const heard: string[] = []
    quota.on('permitted', () => heard.push(`permitted in ${current()}`))
    quota.on('rejected', () => heard.push(`rejected in ${current()}`))
    const ran: string[] = []
    const call = quota.wrap(async (_ctx: CallContext, caller: string) => {
      ran.push(`${caller} in ${current()}`)
    })

    const a = call(ctxOf('a'), 'a')
    const b = call(ctxOf('b'), 'b')
    const c = call(ctxOf('c'), 'c')
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([a, b])
    quota.dispose()
    await expect(c).rejects.toBeInstanceOf(ErrRateLimitExceeded)

    expect(ran).toEqual(['a in none', 'b in b'])
    expect(heard).toEqual(['permitted in none', 'permitted in b', 'rejected in c'])
  })

  it('continues waking queued calls when restoring one caller throws', async () => {
    const quota = limiterOf({ limitForPeriod: 1, limitRefreshPeriod: 100 * Millisecond, maxWaitDuration: 1 * Second })
    const { starts, operation } = recorder()
    const call = quota.wrap((_ctx, caller: string) => operation(caller)())
    const cause = new Error('restore failed')
    const active = call({ signal: undefined }, 'active')
    const failed = call(
      {
        signal: undefined,
        restore: () => {
          throw cause
        },
      },
      'failed',
    )
    const outcome = failed.catch((error: unknown) => error)
    const next = call({ signal: undefined }, 'next')

    await vi.advanceTimersByTimeAsync(200)

    await expect(active).resolves.toBe('active')
    await expect(outcome).resolves.toBe(cause)
    await expect(next).resolves.toBe('next')
    expect(starts).toEqual([
      ['active', 0],
      ['next', 200],
    ])
  })
})
