import { getEventListeners } from 'node:events'

import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { circuitBreaker } from '../circuitbreaker/circuitbreaker.js'
import { compose, runWith } from '../compose.js'
import { ErrInvalidOption } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { retry } from '../retry/retry.js'
import type { ExecutionContext } from '../strategy.js'
import { ErrTimeLimitExceeded, timeLimiter, type TimeLimiterEvents, type TimeLimiterOptions } from './timelimiter.js'

beforeEach(() => {
  useFakeClock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function limiterOf(options: Partial<TimeLimiterOptions> = {}) {
  return timeLimiter({ name: 'inventory', timeoutDuration: 100 * Millisecond, ...options })
}

// An operation that settles only when the test says so, keeping the signal it was handed.
function controllable<T = string>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  let signal: AbortSignal | undefined
  const operation = vi.fn((ctx: ExecutionContext) => {
    signal = ctx.signal
    return new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
  })
  return {
    operation,
    resolve: (value: T) => resolve(value),
    reject: (reason: unknown) => reject(reason),
    signal: () => signal,
  }
}

function listen<K extends keyof TimeLimiterEvents>(
  target: { on: (type: K, listener: (event: TimeLimiterEvents[K]) => unknown) => () => void },
  ...types: K[]
): Array<[K, TimeLimiterEvents[K]]> {
  const seen: Array<[K, TimeLimiterEvents[K]]> = []
  for (const type of types) {
    target.on(type, event => seen.push([type, event]))
  }
  return seen
}

describe('time limiter options', () => {
  it.each([
    [0, '0s'],
    [-1, '-1ms'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [undefined, 'undefined'],
  ])('refuses timeoutDuration %s when it is created, because no value means forever', (timeoutDuration, shown) => {
    const create = () => timeLimiter({ name: 'inventory', timeoutDuration: timeoutDuration as number })

    expect(create).toThrow(ErrInvalidOption)
    expect(create).toThrow(
      `Cannot create time limiter "inventory": timeoutDuration must be a finite Duration greater than 0s, got ${shown}`,
    )
  })

  it('requires a name', () => {
    expect(() => timeLimiter({ name: '', timeoutDuration: 100 * Millisecond })).toThrow(
      'Cannot create time limiter: name must be a non-empty string',
    )
  })

  it('exposes its name', () => {
    expect(limiterOf().name).toBe('inventory')
  })
})

describe('time limiter', () => {
  it('passes the value through and leaves no timer behind when the operation settles in time', async () => {
    const limiter = limiterOf()

    await expect(runWith(() => 'stock', limiter)).resolves.toBe('stock')

    expect(vi.getTimerCount()).toBe(0)
    expect(limiter.metrics()).toEqual({ successfulCalls: 1, failedCalls: 0, timedOutCalls: 0 })
  })

  it('passes the error through unchanged and leaves no timer behind', async () => {
    const limiter = limiterOf()
    const error = new Error('down')

    await expect(
      runWith(() => {
        throw error
      }, limiter),
    ).rejects.toBe(error)

    expect(vi.getTimerCount()).toBe(0)
    expect(limiter.metrics()).toEqual({ successfulCalls: 0, failedCalls: 1, timedOutCalls: 0 })
  })

  // The point of a time limiter: a hung dependency must not hold its caller forever.
  it('rejects at the limit with ErrTimeLimitExceeded, even when the operation never settles', async () => {
    const limiter = limiterOf({ timeoutDuration: 2 * Second })
    const { operation } = controllable()
    let outcome: unknown = 'pending'
    const call = runWith(operation, limiter).then(
      value => (outcome = value),
      (error: unknown) => (outcome = error),
    )

    await vi.advanceTimersByTimeAsync(2 * Second - 1)
    expect(outcome).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await call
    expect(outcome).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(outcome).toMatchObject({
      timeLimiter: 'inventory',
      timeoutDuration: 2 * Second,
      code: 'ERR_TIME_LIMIT_EXCEEDED',
      name: 'ErrTimeLimitExceeded',
    })
    expect((outcome as Error).message).toContain('Cannot complete "inventory": time limit of 2s exceeded')
    expect(limiter.metrics()).toEqual({ successfulCalls: 0, failedCalls: 0, timedOutCalls: 1 })
  })

  // A cooperative operation can stop its own work, and tell a timeout from its caller giving up.
  it('aborts the signal the operation received, with the same error as the reason', async () => {
    const limiter = limiterOf()
    const { operation, signal } = controllable()

    const call = runWith(operation, limiter).catch((reason: unknown) => reason)
    await vi.advanceTimersByTimeAsync(100)
    const error = await call

    expect(error).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(signal()?.aborted).toBe(true)
    expect(signal()?.reason).toBe(error)
  })

  it('hands the operation a signal of its own, not the caller’s', async () => {
    const limiter = limiterOf()
    const caller = new AbortController()
    const { operation, resolve, signal } = controllable()

    const call = runWith(operation, limiter, caller.signal)
    await vi.advanceTimersByTimeAsync(0)
    resolve('ok')
    await call

    expect(signal()).toBeInstanceOf(AbortSignal)
    expect(signal()).not.toBe(caller.signal)
  })

  // The caller giving up is not the dependency being slow: it must not count as a timeout, nor wait for the limit.
  it('rejects with the caller’s reason at once when the caller aborts first, and does not count a timeout', async () => {
    const limiter = limiterOf({ timeoutDuration: 10 * Second })
    const caller = new AbortController()
    const reason = new Error('caller gave up')
    const { operation, signal } = controllable()

    const call = runWith(operation, limiter, caller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    caller.abort(reason)

    expect(await call).toBe(reason)
    expect(signal()?.aborted).toBe(true)
    expect(signal()?.reason).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    expect(limiter.metrics()).toEqual({ successfulCalls: 0, failedCalls: 0, timedOutCalls: 0 })
  })

  it('rejects with the caller’s reason when the operation aborts the caller’s signal while it starts', async () => {
    const limiter = limiterOf({ timeoutDuration: 10 * Second })
    const caller = new AbortController()
    const reason = new Error('aborted inside')

    const call = runWith(
      () => {
        caller.abort(reason)
        return new Promise(() => undefined)
      },
      limiter,
      caller.signal,
    )

    await expect(call).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once, running nothing, when the caller’s signal has already aborted', async () => {
    const limiter = limiterOf()
    const caller = new AbortController()
    const reason = new Error('gone')
    caller.abort(reason)
    const next = vi.fn(() => Promise.resolve('ok'))

    await expect(limiter.run({ signal: caller.signal } as ExecutionContext, next)).rejects.toBe(reason)
    expect(next).not.toHaveBeenCalled()
  })

  it('drops an outcome that arrives after the limit, raising no unhandled rejection', async () => {
    const limiter = limiterOf()
    const late = controllable()
    const early = controllable()

    const timedOut = runWith(late.operation, limiter).catch((error: unknown) => error)
    const other = runWith(early.operation, limiter).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    late.reject(new Error('too late'))
    early.resolve('also too late')
    await vi.advanceTimersByTimeAsync(0)

    expect(await timedOut).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(await other).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(limiter.metrics()).toEqual({ successfulCalls: 0, failedCalls: 0, timedOutCalls: 2 })
  })

  // A server's shutdown signal outlives every call made under it: each call must take its listener with it.
  it('leaves no abort listener on a long-lived caller signal after many calls', async () => {
    const limiter = limiterOf()
    const shutdown = new AbortController()
    const run = compose(limiter)

    for (let i = 0; i < 1_000; i++) {
      await run(() => i, shutdown.signal)
    }
    const hung = run(() => new Promise(() => undefined), shutdown.signal).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    await hung

    expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(0)
  })

  it('reports each outcome to its listeners', async () => {
    const limiter = limiterOf()
    const seen = listen(limiter, 'success', 'failure', 'timeout')
    const error = new Error('down')

    await runWith(() => 'ok', limiter)
    await runWith(() => {
      throw error
    }, limiter).catch(() => undefined)
    const hung = runWith(() => new Promise(() => undefined), limiter).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    await hung

    expect(seen).toEqual([
      ['success', { name: 'inventory', duration: 0 }],
      ['failure', { name: 'inventory', duration: 0, error }],
      ['timeout', { name: 'inventory', timeoutDuration: 100 * Millisecond }],
    ])
  })

  it('holds a limit beyond what timers can hold to the longest delay they honour', async () => {
    const limiter = limiterOf({ timeoutDuration: Number.MAX_SAFE_INTEGER })
    const call = runWith(() => new Promise(() => undefined), limiter).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(2_147_483_646)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(await call).toBeInstanceOf(ErrTimeLimitExceeded)
  })
})

describe('time limiter in a chain', () => {
  // Inside a retry, a timeout is one failed attempt: the next attempt gets the whole limit and a signal not yet aborted.
  it('gives each attempt of a retry its own limit and its own signal', async () => {
    const limiter = limiterOf()
    const retries = retry({ name: 'inventory', maxAttempts: 2, backoff: 0 })
    const signals: AbortSignal[] = []
    let attempt = 0

    const call = runWith(
      ctx => {
        signals.push(ctx.signal!)
        attempt++
        return attempt === 1 ? new Promise(() => undefined) : 'ok'
      },
      retries,
      limiter,
    )
    await vi.advanceTimersByTimeAsync(100)

    await expect(call).resolves.toBe('ok')
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(limiter.metrics()).toEqual({ successfulCalls: 1, failedCalls: 0, timedOutCalls: 1 })
  })

  // Outside a retry, the limit is a budget for the whole call: a wait between attempts is cut short too.
  it('bounds every attempt and every wait between them when it sits outside the retry', async () => {
    const limiter = limiterOf({ timeoutDuration: 1 * Second })
    const retries = retry({ name: 'inventory', maxAttempts: 5, backoff: 400 * Millisecond })
    let attempts = 0

    const call = runWith(
      () => {
        attempts++
        throw new Error('down')
      },
      limiter,
      retries,
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(await call).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(attempts).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a timeout as a failure of the circuit breaker outside it', async () => {
    const breaker = circuitBreaker({
      name: 'inventory',
      minimumNumberOfCalls: 1,
      slidingWindow: { type: 'count', size: 1 },
    })
    const limiter = limiterOf()

    const call = runWith(() => new Promise(() => undefined), breaker, limiter).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    await call

    expect(breaker.metrics().failedCalls).toBe(1)
    expect(breaker.state).toBe('open')
  })

  it('leaves the circuit breaker outside it untouched when the caller aborts', async () => {
    const breaker = circuitBreaker({
      name: 'inventory',
      minimumNumberOfCalls: 1,
      slidingWindow: { type: 'count', size: 1 },
    })
    const limiter = limiterOf({ timeoutDuration: 10 * Second })
    const caller = new AbortController()

    const call = runWith(() => new Promise(() => undefined), breaker, limiter, caller.signal).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    caller.abort()
    await call

    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(breaker.state).toBe('closed')
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
      function callsTheLimiter(): Promise<unknown> {
        return limited(operationThatThrows)
      }

      const error = (await callsTheLimiter().catch((reason: unknown) => reason)) as Error
      const lines = error.stack?.split('\n') ?? []
      const operation = lines.findIndex(line => line.includes('operationThatThrows'))
      const entry = lines.findIndex(line => line.includes('callsTheLimiter'))

      expect(operation).toBeGreaterThan(0)
      expect(entry - operation - 1).toBeLessThanOrEqual(3)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})
