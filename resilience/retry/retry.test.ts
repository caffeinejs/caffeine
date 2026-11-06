import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrBulkheadFull } from '../bulkhead/bulkhead.js'
import { ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { fakeTimersClock } from '../clock.testkit.js'
import { compose, run } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import type { Operation, Policy } from '../policy.js'
import { ErrRateLimitExceeded } from '../ratelimiter/ratelimiter.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'
import { unhandledRejections } from '../unhandled.testkit.js'
import { ErrMaxRetriesExceeded, retry, type RetryEvents, type RetryOptions } from './retry.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function retryOf(options: Partial<RetryOptions> = {}) {
  return retry({ name: 'inventory', backoff: 0, clock: fakeTimersClock, ...options })
}

// An operation that fails `failures` times, then returns `value`, numbering each attempt it ran.
function flaky(failures: number, value = 'ok') {
  const attempts: number[] = []
  const operation = vi.fn(async () => {
    attempts.push(attempts.length + 1)
    if (attempts.length <= failures) {
      throw new Error(`failure ${attempts.length}`)
    }
    return value
  })
  return { operation, attempts }
}

function listen<K extends keyof RetryEvents>(
  target: { on: (type: K, listener: (event: RetryEvents[K]) => unknown) => () => void },
  ...types: K[]
): Array<[K, RetryEvents[K]]> {
  const seen: Array<[K, RetryEvents[K]]> = []
  for (const type of types) {
    target.on(type, event => seen.push([type, event]))
  }
  return seen
}

describe('retry options', () => {
  it.each([
    [{ maxAttempts: 0 }, 'maxAttempts must be an integer of at least 1, got 0'],
    [{ maxAttempts: 2.5 }, 'maxAttempts must be an integer of at least 1, got 2.5'],
    [{ backoff: -1 }, 'backoff must be a finite Duration of at least 0s or a function, got -1ms'],
    [{ backoff: Number.NaN }, 'backoff must be a finite Duration of at least 0s or a function, got NaN'],
    [{ retryOn: 'all' }, 'retryOn must be a function or an array of error classes, got a string'],
    [{ discard: true }, 'discard must be a function, got boolean'],
    [{ retryOnResult: 1 }, 'retryOnResult must be a function, got number'],
    [{ failAfterMaxAttempts: 'yes' }, 'failAfterMaxAttempts must be a boolean, got string'],
  ])('rejects %o when the retry is created, naming it', (options, reason) => {
    expect(() => retry({ name: 'inventory', ...(options as object) })).toThrow(ErrInvalidOption)
    expect(() => retry({ name: 'inventory', ...(options as object) })).toThrow(
      `Cannot create retry "inventory": ${reason}`,
    )
  })

  it('requires a name', () => {
    expect(() => retry({ name: '' })).toThrow('Cannot create retry: name must be a non-empty string')
  })
})

describe('retry', () => {
  it('counts the first call as an attempt, and rejects with the last error once all are used', async () => {
    const retries = retryOf({ maxAttempts: 3 })
    const { operation, attempts } = flaky(5)

    await expect(run(retries.wrap(operation))).rejects.toThrow('failure 3')

    expect(attempts).toEqual([1, 2, 3])
  })

  it('returns the first successful result', async () => {
    const retries = retryOf({ maxAttempts: 5 })
    const { operation, attempts } = flaky(2, 'stock')

    await expect(run(retries.wrap(operation))).resolves.toBe('stock')
    expect(attempts).toEqual([1, 2, 3])
  })

  it('waits the backoff between attempts', async () => {
    const retries = retryOf({ backoff: 100 })
    const { operation, attempts } = flaky(1)

    const call = run(retries.wrap(operation))
    await vi.advanceTimersByTimeAsync(99)
    expect(attempts).toEqual([1])

    await vi.advanceTimersByTimeAsync(1)
    await expect(call).resolves.toBe('ok')
    expect(attempts).toEqual([1, 2])
  })

  it('asks the backoff for each delay with the failed attempt and its error or result', async () => {
    const calls: unknown[][] = []
    const retries = retryOf({
      maxAttempts: 3,
      retryOnResult: result => result === 'busy',
      backoff: (...args) => {
        calls.push(args)
        return 10
      },
    })
    const error = new Error('down')
    let attempt = 0
    const call = run(
      retries.wrap(async () => {
        attempt++
        if (attempt === 1) {
          throw error
        }
        return attempt === 2 ? 'busy' : 'ok'
      }),
    )

    await vi.advanceTimersByTimeAsync(20)

    await expect(call).resolves.toBe('ok')
    expect(calls).toEqual([
      [1, error, undefined],
      [2, undefined, 'busy'],
    ])
  })

  // Retrying into an open breaker only delays the failure the breaker exists to make fast.
  it('does not retry a refusal from a circuit breaker by default', async () => {
    const retries = retryOf()
    const refusal = new ErrCallNotPermitted('inventory', 'open', 1_000)
    const operation = vi.fn(() => {
      throw refusal
    })

    await expect(run(retries.wrap(operation))).rejects.toBe(refusal)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  // A predicate written for transient errors, such as `() => true`, must not turn an open breaker, a full bulkhead or
  // a spent quota into a retry storm: a refusal means the operation never ran, and retrying it at once adds load.
  it.each([
    ['an open circuit breaker', new ErrCallNotPermitted('inventory', 'open', 1_000)],
    ['a full bulkhead', new ErrBulkheadFull('inventory', 2, 0)],
    ['a spent rate limit', new ErrRateLimitExceeded('inventory', 100, 1 * Second, 400 * Millisecond)],
    ['any other refusal', new ErrCallRefused('Cannot call "inventory": queue is full', 'ERR_QUEUE_FULL', undefined)],
  ])('never retries %s, whatever retryOn says', async (_, refusal) => {
    const retryOn = vi.fn(() => true)
    const retries = retryOf({ retryOn })
    const operation = vi.fn(() => {
      throw refusal
    })

    await expect(run(retries.wrap(operation))).rejects.toBe(refusal)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(retryOn).not.toHaveBeenCalled()
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
  })

  // A refusal promises the operation did not run. Once an earlier attempt reached it, that promise is false for the
  // call: a caller that falls back only on a refusal would treat a write that may have gone through as never sent.
  it('rejects with the earlier attempt’s error, not a refusal that ends the retries after it', async () => {
    const retries = retryOf({ maxAttempts: 3 })
    const seen = listen(retries, 'ignored')
    const timeout = new Error('no answer in time')
    const refusal = new ErrCallNotPermitted('inventory', 'open', 1_000)
    const operation = vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(refusal)

    await expect(run(retries.wrap(operation))).rejects.toBe(timeout)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 2, error: refusal }]])
    expect(retries.metrics().failedCallsWithRetry).toBe(1)
  })

  it('hands back the earlier attempt’s retryable result when a refusal ends the retries after it', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy' })
    const operation = vi
      .fn()
      .mockResolvedValueOnce('busy')
      .mockRejectedValueOnce(new ErrBulkheadFull('inventory', 2, 0))

    await expect(run(retries.wrap(operation))).resolves.toBe('busy')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('rejects with ErrMaxRetriesExceeded over that result when told to fail rather than hand it back', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy', failAfterMaxAttempts: true })
    const operation = vi
      .fn()
      .mockResolvedValueOnce('busy')
      .mockRejectedValueOnce(new ErrBulkheadFull('inventory', 2, 0))

    const error = await run(retries.wrap(operation)).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ErrMaxRetriesExceeded)
    expect(error).toMatchObject({
      attempts: 1,
      result: 'busy',
      message: expect.stringContaining(
        'Cannot complete "inventory": attempt 2 was refused after attempt 1 returned a retryable result',
      ),
    })
  })

  it('never retries a failure after the caller aborted, whatever retryOn says', async () => {
    const retryOn = vi.fn(() => true)
    const retries = retryOf({ retryOn })
    const controller = new AbortController()
    const operation = vi.fn(() => {
      controller.abort()
      throw new Error('cancelled')
    })

    await expect(run(retries.wrap(operation), controller.signal)).rejects.toThrow('cancelled')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(retryOn).not.toHaveBeenCalled()
  })

  // A timeout is the dependency being slow, not a refusal: the next attempt may well be fast.
  it('retries a time limit by default', async () => {
    const retries = retryOf()
    let attempt = 0
    const operation = vi.fn(async () => {
      attempt++
      if (attempt === 1) {
        throw new ErrTimeLimitExceeded('inventory', 100 * Millisecond)
      }
      return 'ok'
    })

    await expect(run(retries.wrap(operation))).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('asks retryOn about every other error, the last attempt included', async () => {
    const seen: Array<[unknown, number]> = []
    const retries = retryOf({
      retryOn: (error, attempt) => {
        seen.push([error, attempt])
        return true
      },
    })
    const error = new Error('down')
    const operation = vi.fn(() => {
      throw error
    })

    await expect(run(retries.wrap(operation))).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(3)
    // Consulted on the last attempt too: it decides whether the call ends as exhausted or as not retryable.
    expect(seen).toEqual([
      [error, 1],
      [error, 2],
      [error, 3],
    ])
  })

  // A promise is truthy: an async predicate would retry every error, whatever it resolved to.
  it.each([
    ['a promise', Promise.resolve(false)],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects with ErrInvalidOption when retryOn returns %s, and counts the call as failed', async (got, verdict) => {
    const retries = retryOf({ retryOn: (() => verdict) as never })
    const seen = listen(retries, 'ignored')
    const { operation, attempts } = flaky(5)

    const error = await run(retries.wrap(operation)).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain(
      `Cannot run retry "inventory": retryOn must return a boolean, got ${got}`,
    )
    expect(attempts).toEqual([1])
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error }]])
  })

  it.each([
    ['a promise', Promise.resolve(false)],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects with ErrInvalidOption when retryOnResult returns %s', async (got, verdict) => {
    const retries = retryOf({ retryOnResult: (() => verdict) as never })
    const operation = vi.fn(async () => 'busy')

    const error = await run(retries.wrap(operation)).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain(
      `Cannot run retry "inventory": retryOnResult must return a boolean, got ${got}`,
    )
    expect(operation).toHaveBeenCalledTimes(1)
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
  })

  // Clients that back off in lockstep reach a recovering dependency together. The default spreads them: 500 ms
  // doubling per attempt, each delay anywhere within half of it either way.
  it.each([
    [0, [250, 500]],
    [1, [750, 1_500]],
  ])('backs off exponentially with jitter by default: Math.random() = %d waits %o', async (random, [first, second]) => {
    vi.spyOn(Math, 'random').mockReturnValue(random)
    const retries = retry({ name: 'inventory' })
    const { operation, attempts } = flaky(2)

    const call = run(retries.wrap(operation))
    await vi.advanceTimersByTimeAsync(first - 1)
    expect(attempts).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toEqual([1, 2])

    await vi.advanceTimersByTimeAsync(second - 1)
    expect(attempts).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(1)
    await expect(call).resolves.toBe('ok')
    expect(attempts).toEqual([1, 2, 3])
  })

  it('stops at an error that retryOn declines', async () => {
    const retries = retryOf({ retryOn: error => !(error instanceof TypeError) })
    const operation = vi.fn(() => {
      throw new TypeError('bad input')
    })

    await expect(run(retries.wrap(operation))).rejects.toThrow('bad input')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries a result that retryOnResult asks for, until one it accepts', async () => {
    const retries = retryOf({ maxAttempts: 5, retryOnResult: result => result === 'busy' })
    const results = ['busy', 'busy', 'done']

    await expect(run(retries.wrap(async () => results.shift()))).resolves.toBe('done')
    expect(results).toEqual([])
  })

  // A dependency that answers "busy" to every attempt is not healthy, even when the caller takes the answer.
  it('hands back the last retryable result once all attempts are used, and counts the call as failed', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy' })
    const seen = listen(retries, 'success', 'failure')

    await expect(run(retries.wrap(async () => 'busy'))).resolves.toBe('busy')
    expect(retries.metrics()).toMatchObject({ successfulCallsWithRetry: 0, failedCallsWithRetry: 1 })
    expect(seen).toEqual([['failure', { name: 'inventory', attempts: 3, result: 'busy' }]])
  })

  it('rejects with ErrMaxRetriesExceeded carrying the last result when told to fail', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy', failAfterMaxAttempts: true })
    const seen = listen(retries, 'failure')

    const error = await run(retries.wrap(async () => 'busy')).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrMaxRetriesExceeded)
    expect(error).toMatchObject({
      attempts: 3,
      result: 'busy',
      code: 'ERR_MAX_RETRIES_EXCEEDED',
      message: 'Cannot complete "inventory": result still retryable after 3 attempts',
    })
    expect(seen).toEqual([['failure', { name: 'inventory', attempts: 3, result: 'busy' }]])
  })

  it('counts one attempt as one in the message', async () => {
    const retries = retryOf({ maxAttempts: 1, retryOnResult: result => result === 'busy', failAfterMaxAttempts: true })

    const error = await run(retries.wrap(async () => 'busy')).catch((reason: unknown) => reason)

    expect((error as Error).message).toBe('Cannot complete "inventory": result still retryable after 1 attempt')
  })

  // A caller that gave up wants its answer now, not after the remaining attempts.
  it('rejects with the abort reason at once when the caller aborts during a wait, without another attempt', async () => {
    const retries = retryOf({ backoff: 60_000 })
    const seen = listen(retries, 'ignored')
    const { operation, attempts } = flaky(5)
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const call = run(retries.wrap(operation), controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)

    await expect(call).rejects.toBe(reason)
    expect(attempts).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error: reason }]])
  })

  it('does not retry a failure that settles after the caller aborted', async () => {
    const retries = retryOf()
    const controller = new AbortController()
    const operation = vi.fn(() => {
      controller.abort()
      throw new Error('cancelled')
    })

    await expect(run(retries.wrap(operation), controller.signal)).rejects.toThrow('cancelled')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('rejects with ErrInvalidOption when the backoff returns no usable delay', async () => {
    const retries = retryOf({ backoff: () => Number.POSITIVE_INFINITY })

    await expect(run(retries.wrap(flaky(1).operation))).rejects.toThrow(
      'Cannot schedule retry "inventory": delay must be a finite number, got Infinity',
    )
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
  })

  // A predicate or backoff that throws ends the call. The call still happened, so it must show in the counts.
  it('counts the call as failed when retryOn throws, and rejects with what it threw', async () => {
    const thrown = new Error('bad predicate')
    const retries = retryOf({
      retryOn: () => {
        throw thrown
      },
    })
    const seen = listen(retries, 'retry', 'ignored')

    await expect(run(retries.wrap(flaky(1).operation))).rejects.toBe(thrown)
    expect(retries.metrics()).toEqual({
      successfulCallsWithoutRetry: 0,
      successfulCallsWithRetry: 0,
      failedCallsWithoutRetry: 1,
      failedCallsWithRetry: 0,
    })
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error: thrown }]])
  })

  it('counts the call as failed when retryOnResult throws, and rejects with what it threw', async () => {
    const thrown = new Error('bad predicate')
    const retries = retryOf({
      retryOnResult: () => {
        throw thrown
      },
    })
    const seen = listen(retries, 'retry', 'ignored')

    await expect(run(retries.wrap(async () => 'ok'))).rejects.toBe(thrown)
    expect(retries.metrics()).toEqual({
      successfulCallsWithoutRetry: 0,
      successfulCallsWithRetry: 0,
      failedCallsWithoutRetry: 1,
      failedCallsWithRetry: 0,
    })
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error: thrown }]])
  })

  it('counts the call as failed when the backoff throws, and rejects with what it threw', async () => {
    const thrown = new Error('bad backoff')
    const retries = retryOf({
      backoff: () => {
        throw thrown
      },
    })
    const seen = listen(retries, 'retry', 'ignored')

    await expect(run(retries.wrap(flaky(1).operation))).rejects.toBe(thrown)
    expect(retries.metrics()).toEqual({
      successfulCallsWithoutRetry: 0,
      successfulCallsWithRetry: 0,
      failedCallsWithoutRetry: 1,
      failedCallsWithRetry: 0,
    })
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error: thrown }]])
  })

  // An attempt chained to the one before it is memory the call holds until it ends, and a tick its caller waits.
  it('settles a call in the same number of ticks however many attempts it used', async () => {
    const ticksToSettle = async (attempts: number): Promise<number> => {
      const last = Promise.withResolvers<string>()
      let calls = 0
      let done = false
      void run(
        retryOf({ maxAttempts: attempts }).wrap(async () => {
          calls++
          if (calls === attempts) {
            return last.promise
          }
          throw new Error('down')
        }),
      ).then(() => {
        done = true
      })

      while (calls < attempts) {
        await Promise.resolve()
      }
      last.resolve('ok')
      let ticks = 0
      while (!done) {
        await Promise.resolve()
        ticks++
      }
      return ticks
    }

    expect(await ticksToSettle(50)).toBe(await ticksToSettle(2))
  })

  // setTimeout fires at once for delays it cannot represent; clamping keeps a huge backoff a long wait.
  it('clamps a delay beyond what timers can hold', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const retries = retryOf({ backoff: 10 * 2_147_483_647 })
    const seen = listen(retries, 'retry')

    void run(retries.wrap(flaky(1).operation)).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647)
    expect(seen[0][1]).toMatchObject({ attempt: 1, delay: 2_147_483_647 })
  })

  it('reports each retry before sleeping, then the outcome', async () => {
    const retries = retryOf({ backoff: 25 })
    const seen = listen(retries, 'retry', 'success')
    const { operation } = flaky(1)

    const call = run(retries.wrap(operation))
    await vi.advanceTimersByTimeAsync(25)
    await call

    expect(seen).toEqual([
      ['retry', { name: 'inventory', attempt: 1, delay: 25, error: new Error('failure 1') }],
      ['success', { name: 'inventory', attempts: 2 }],
    ])
  })

  it('reports a retry for a result with the delay it waits, then the outcome', async () => {
    const retries = retryOf({ backoff: 25 * Millisecond, retryOnResult: result => result === 'busy' })
    const seen = listen(retries, 'retry', 'success')
    const results = ['busy', 'done']

    const call = run(retries.wrap(async () => results.shift()))
    await vi.advanceTimersByTimeAsync(25)
    await expect(call).resolves.toBe('done')

    expect(seen).toEqual([
      ['retry', { name: 'inventory', attempt: 1, delay: 25 * Millisecond, result: 'busy' }],
      ['success', { name: 'inventory', attempts: 2 }],
    ])
  })

  // One count per call, split the way dashboards ask: did it work, and did it need a retry.
  it('counts each call once, by outcome and by whether it needed a retry', async () => {
    const retries = retryOf({ retryOn: error => !(error instanceof TypeError) })

    await run(retries.wrap(async () => 'ok'))
    await run(retries.wrap(flaky(1).operation))
    await run(
      retries.wrap(async () => {
        throw new TypeError('bad input')
      }),
    ).catch(() => undefined)
    await run(retries.wrap(flaky(9).operation)).catch(() => undefined)

    expect(retries.metrics()).toEqual({
      successfulCallsWithoutRetry: 1,
      successfulCallsWithRetry: 1,
      failedCallsWithoutRetry: 1,
      failedCallsWithRetry: 1,
    })
  })

  // A policy inside the retry that throws before returning a promise is still a failed attempt, not a crash.
  it('counts a synchronous throw from the inner chain as a failed attempt and retries it', async () => {
    const retries = retryOf()
    let calls = 0
    const throwsOnce: Policy = op => (ctx, input) => {
      calls++
      if (calls === 1) {
        throw new Error('inner policy bug')
      }
      return op(ctx, input)
    }

    await expect(run(compose(retries, throwsOnce)(async () => 'ok'))).resolves.toBe('ok')
    expect(calls).toBe(2)
    expect(retries.metrics().successfulCallsWithRetry).toBe(1)
  })

  // `wrap` is public: an operation wrapped by hand may throw synchronously or return a plain value. A synchronous
  // throw is still a failed attempt, and a plain value is still a result.
  it('retries an operation wrapped by hand that throws synchronously on its first attempt', async () => {
    const retries = retryOf()
    let calls = 0
    const throwsOnce = (() => {
      calls++
      if (calls === 1) {
        throw new Error('hand-made operation bug')
      }
      return Promise.resolve('ok')
    }) as Operation<string>
    let result: Promise<string> | undefined

    expect(() => {
      result = retries.wrap(throwsOnce)({ signal: undefined }, undefined)
    }).not.toThrow()
    await expect(result).resolves.toBe('ok')
    expect(calls).toBe(2)
    expect(retries.metrics().successfulCallsWithRetry).toBe(1)
  })

  it('counts every attempt of an operation wrapped by hand that always throws synchronously', async () => {
    const retries = retryOf({ maxAttempts: 2 })
    let calls = 0
    const alwaysThrows = (() => {
      calls++
      throw new Error('hand-made operation bug')
    }) as Operation<string>

    await expect(run(retries.wrap(alwaysThrows))).rejects.toThrow('hand-made operation bug')
    expect(calls).toBe(2)
    expect(retries.metrics().failedCallsWithRetry).toBe(1)
  })

  it('treats a plain value from an operation wrapped by hand as the result', async () => {
    const retries = retryOf()
    const plainValue = (() => 'value') as unknown as Operation<string>

    await expect(run(retries.wrap(plainValue))).resolves.toBe('value')
    expect(retries.metrics().successfulCallsWithoutRetry).toBe(1)
  })

  it('exposes its name', () => {
    expect(retryOf().name).toBe('inventory')
  })
})

describe('retry, unhandled rejections', () => {
  // Every way a call can end must settle the caller's promise and leave no other one rejected behind it.
  it('leaves no rejection unhandled, whichever way a call ends', async () => {
    const reasons = await unhandledRejections(async () => {
      const down = () => Promise.reject(new Error('down'))
      const caller = new AbortController()
      const waiting = retryOf({ backoff: 1 * Second })
      const disposed = retryOf({ backoff: 1 * Second })
      const refused = vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValue(new ErrBulkheadFull('x', 1, 0))
      const calls = [
        run(waiting.wrap(down), caller.signal),
        run(disposed.wrap(down)),
        run(retryOf().wrap(refused)),
        run(retryOf({ backoff: () => Number.NaN }).wrap(down)),
        run(
          retryOf({
            retryOn: () => {
              throw new Error('retryOn bug')
            },
          }).wrap(down),
        ),
        run(retryOf({ retryOnResult: () => true, failAfterMaxAttempts: true }).wrap(async () => 'busy')),
      ].map(call => call.catch(() => undefined))
      await vi.advanceTimersByTimeAsync(0)
      caller.abort()
      disposed.dispose()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.all(calls)
    })

    expect(reasons).toEqual([])
  })
})

describe('retry, client errors', () => {
  class ErrNotFound extends Error {}
  const isClientError = (error: unknown): boolean => error instanceof ErrNotFound

  // A request for a record that does not exist gets the same answer every time: running it again only multiplies the
  // work one client can cause.
  it('never retries an error the context calls a client error, whatever retryOn says', async () => {
    const retries = retryOf({ maxAttempts: 3, retryOn: () => true })
    const seen = listen(retries, 'ignored', 'retry', 'failure')
    const missing = new ErrNotFound('no such record')
    const operation = vi.fn(async () => {
      throw missing
    })

    const error = await retries
      .wrap(operation)({ signal: undefined, isClientError }, undefined)
      .catch((thrown: unknown) => thrown)

    expect(error).toBe(missing)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error: missing }]])
  })

  it('still retries an error the context does not call a client error', async () => {
    const retries = retryOf({ maxAttempts: 3 })
    const { operation, attempts } = flaky(2)

    const answer = await retries.wrap(operation)({ signal: undefined, isClientError }, undefined)

    expect(answer).toBe('ok')
    expect(attempts).toEqual([1, 2, 3])
  })
})

describe('retry, retryOn as error classes', () => {
  // A class list says what a predicate of instanceof checks would, without the chance to get one wrong.
  it('retries an error of a listed class, a subclass included, and stops at any other', async () => {
    class ErrUnavailable extends Error {}
    class ErrGatewayTimeout extends ErrUnavailable {}
    const retries = retryOf({ retryOn: [ErrUnavailable], maxAttempts: 3 })
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new ErrGatewayTimeout('slow'))
      .mockRejectedValueOnce(new ErrUnavailable('down'))
      .mockRejectedValueOnce(new TypeError('bug'))

    await expect(run(retries.wrap(operation))).rejects.toBeInstanceOf(TypeError)
    expect(operation).toHaveBeenCalledTimes(3)

    const declined = vi.fn().mockRejectedValue(new TypeError('bug'))
    await expect(run(retries.wrap(declined))).rejects.toBeInstanceOf(TypeError)
    expect(declined).toHaveBeenCalledTimes(1)
  })

  it('never retries a refusal, even one of a listed class', async () => {
    const retries = retryOf({ retryOn: [ErrCallRefused] })
    const operation = vi.fn().mockRejectedValue(new ErrBulkheadFull('inventory', 2, 0))

    await expect(run(retries.wrap(operation))).rejects.toBeInstanceOf(ErrBulkheadFull)
    expect(operation).toHaveBeenCalledTimes(1)
  })
})

describe('retry, discard', () => {
  // A 503 whose body nobody reads holds its connection through the whole wait.
  it('hands each result it retries to discard, after the retry event and before the wait', async () => {
    const order: string[] = []
    const retries = retryOf({
      maxAttempts: 3,
      backoff: 100 * Millisecond,
      retryOnResult: result => result !== 'ok',
      discard: result => order.push(`discard ${String(result)}`),
    })
    retries.on('retry', event => order.push(`retry ${String(event.result)}`))
    const operation = vi.fn().mockResolvedValueOnce('busy 1').mockResolvedValueOnce('busy 2').mockResolvedValue('ok')

    const call = run(retries.wrap(operation))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['retry busy 1', 'discard busy 1'])
    await vi.advanceTimersByTimeAsync(200)

    await expect(call).resolves.toBe('ok')
    expect(order).toEqual(['retry busy 1', 'discard busy 1', 'retry busy 2', 'discard busy 2'])
  })

  // The caller owns the result it receives: releasing it would hand back a response whose body is gone.
  it('never discards the result the caller receives, the last retryable one included', async () => {
    const discard = vi.fn()
    const retries = retryOf({ maxAttempts: 2, retryOnResult: result => result === 'busy', discard })
    const operation = vi.fn().mockResolvedValueOnce('busy').mockResolvedValueOnce('busy')

    await expect(run(retries.wrap(operation))).resolves.toBe('busy')
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('never discards an error', async () => {
    const discard = vi.fn()
    const { operation } = flaky(1)

    await expect(run(retryOf({ discard }).wrap(operation))).resolves.toBe('ok')
    expect(discard).not.toHaveBeenCalled()
  })

  // Handing back a result whose body was released would fail where the caller reads it, far from the cause.
  it('rejects with ErrMaxRetriesExceeded over a discarded result when a refusal ends the retries after it', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy', discard: () => undefined })
    const operation = vi
      .fn()
      .mockResolvedValueOnce('busy')
      .mockRejectedValueOnce(new ErrBulkheadFull('inventory', 2, 0))

    const error = await run(retries.wrap(operation)).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ErrMaxRetriesExceeded)
    expect(error).toMatchObject({ attempts: 1, result: 'busy' })
  })

  // A discard releases a result nobody will read. Its failure has no caller to reach: rethrown as uncaught, it would
  // stop the process over a cleanup.
  it.each([
    [
      'throws',
      () => {
        throw new Error('discard bug')
      },
    ],
    ['rejects', () => Promise.reject(new TypeError('stream errored'))],
  ])('keeps the call going when discard %s, and drops its error', async (_how, discard) => {
    const queued: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (callback: () => void) => queued.push(callback))
    const retries = retryOf({
      backoff: 100 * Millisecond,
      retryOnResult: result => result === 'busy',
      discard,
    })
    const operation = vi.fn().mockResolvedValueOnce('busy').mockResolvedValueOnce('ok')
    let answered: unknown

    const reasons = await unhandledRejections(async () => {
      const call = run(retries.wrap(operation))
      await vi.advanceTimersByTimeAsync(100)
      answered = await call
    })

    expect(answered).toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(reasons).toEqual([])
    expect(queued).toEqual([])
  })
})

describe('retry, dispose', () => {
  // A shutdown must not wait out a backoff of seconds.
  it('ends a waiting call at once with its last error, leaving no timer', async () => {
    const retries = retryOf({ backoff: 30 * Second })
    const seen = listen(retries, 'ignored')
    const down = new Error('down')
    const operation = vi.fn().mockRejectedValue(down)
    const call = run(retries.wrap(operation)).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    retries.dispose()

    expect(await call).toBe(down)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, error: down }]])
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
  })

  it('ends a waiting call at once with its last result', async () => {
    const retries = retryOf({ backoff: 30 * Second, retryOnResult: result => result === 'busy' })
    const seen = listen(retries, 'ignored')
    const call = run(retries.wrap(async () => 'busy'))
    await vi.advanceTimersByTimeAsync(0)

    retries.dispose()

    await expect(call).resolves.toBe('busy')
    expect(seen).toEqual([['ignored', { name: 'inventory', attempts: 1, result: 'busy' }]])
  })

  // A listener may react to the shutdown by disposing again; each call must still end, and count, once.
  it('ends each waiting call once when an ignored listener disposes the retry again', async () => {
    const retries = retryOf({ backoff: 30 * Second })
    const seen = listen(retries, 'ignored')
    retries.on('ignored', () => retries.dispose())
    const calls = ['a', 'b'].map(id =>
      run(retries.wrap(vi.fn().mockRejectedValue(new Error(id)))).catch((error: unknown) => (error as Error).message),
    )
    await vi.advanceTimersByTimeAsync(0)

    retries.dispose()

    expect(await Promise.all(calls)).toEqual(['a', 'b'])
    expect(seen.map(([, event]) => (event.error as Error).message)).toEqual(['a', 'b'])
    expect(retries.metrics().failedCallsWithoutRetry).toBe(2)
  })

  it('rejects a waiting call with ErrMaxRetriesExceeded when its last result went to discard', async () => {
    const retries = retryOf({ backoff: 30 * Second, retryOnResult: result => result === 'busy', discard: vi.fn() })
    const call = run(retries.wrap(async () => 'busy')).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)

    retries.dispose()

    expect(await call).toBeInstanceOf(ErrMaxRetriesExceeded)
    expect(await call).toMatchObject({
      attempts: 1,
      result: 'busy',
      message: expect.stringContaining(
        'Cannot complete "inventory": retry was disposed before attempt 2, after attempt 1 returned a retryable result',
      ),
    })
  })

  // A call that arrives during a shutdown must not start a wait the shutdown already ended for the others.
  it('ends a later call at once where it would wait, without discarding the result it hands back', async () => {
    const discard = vi.fn()
    const retries = retryOf({ backoff: 30 * Second, retryOnResult: result => result === 'busy', discard })
    retries.dispose()

    await expect(run(retries.wrap(async () => 'busy'))).resolves.toBe('busy')
    const { operation } = flaky(1)
    await expect(run(retries.wrap(operation))).rejects.toThrow('failure 1')

    expect(discard).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is what a using declaration calls at the end of its block', async () => {
    const { operation } = flaky(5)
    let call: Promise<unknown> | undefined
    {
      using retries = retryOf({ backoff: 30 * Second })
      call = run(retries.wrap(operation)).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(((await call) as Error).message).toBe('failure 1')
    expect(vi.getTimerCount()).toBe(0)
  })
})
