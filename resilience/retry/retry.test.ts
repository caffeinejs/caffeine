import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runWith } from '../compose.js'
import { ErrCallNotPermitted, ErrInvalidOption, ErrMaxRetriesExceeded } from '../errors.js'
import type { ExecutionContext, Next, Strategy } from '../strategy.js'
import { retry, type RetryEvents, type RetryOptions } from './retry.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function retryOf(options: Partial<RetryOptions> = {}) {
  return retry({ name: 'inventory', backoff: 0, ...options })
}

// An operation that fails `failures` times, then returns `value`, recording the attempt number it saw each time.
function flaky(failures: number, value = 'ok') {
  const attempts: number[] = []
  const operation = vi.fn(({ attempt }: { attempt: number }) => {
    attempts.push(attempt)
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
    [{ backoff: -1 }, 'backoff must be a finite number of at least 0 or a function, got -1'],
    [{ backoff: Number.NaN }, 'backoff must be a finite number of at least 0 or a function, got NaN'],
    [{ retryOn: 'all' }, 'retryOn must be a function, got string'],
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

    await expect(runWith(operation, retries)).rejects.toThrow('failure 3')

    expect(attempts).toEqual([1, 2, 3])
  })

  it('returns the first successful result', async () => {
    const retries = retryOf({ maxAttempts: 5 })
    const { operation, attempts } = flaky(2, 'stock')

    await expect(runWith(operation, retries)).resolves.toBe('stock')
    expect(attempts).toEqual([1, 2, 3])
  })

  it('waits the backoff between attempts', async () => {
    const retries = retryOf({ backoff: 100 })
    const { operation, attempts } = flaky(1)

    const call = runWith(operation, retries)
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
    const call = runWith(() => {
      attempt++
      if (attempt === 1) {
        throw error
      }
      return attempt === 2 ? 'busy' : 'ok'
    }, retries)

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

    await expect(runWith(operation, retries)).rejects.toBe(refusal)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('replaces the default entirely with a retryOn of its own', async () => {
    const seen: Array<[unknown, number]> = []
    const retries = retryOf({
      retryOn: (error, attempt) => {
        seen.push([error, attempt])
        return true
      },
    })
    const refusal = new ErrCallNotPermitted('inventory', 'open', 1_000)
    const operation = vi.fn(() => {
      throw refusal
    })

    await expect(runWith(operation, retries)).rejects.toBe(refusal)

    expect(operation).toHaveBeenCalledTimes(3)
    // Consulted on the last attempt too: it decides whether the call ends as exhausted or as not retryable.
    expect(seen).toEqual([
      [refusal, 1],
      [refusal, 2],
      [refusal, 3],
    ])
  })

  it('stops at an error that retryOn declines', async () => {
    const retries = retryOf({ retryOn: error => !(error instanceof TypeError) })
    const operation = vi.fn(() => {
      throw new TypeError('bad input')
    })

    await expect(runWith(operation, retries)).rejects.toThrow('bad input')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries a result that retryOnResult asks for, until one it accepts', async () => {
    const retries = retryOf({ maxAttempts: 5, retryOnResult: result => result === 'busy' })
    const results = ['busy', 'busy', 'done']

    await expect(runWith(() => results.shift(), retries)).resolves.toBe('done')
    expect(results).toEqual([])
  })

  // A dependency that answers "busy" to every attempt is not healthy, even when the caller takes the answer.
  it('hands back the last retryable result once all attempts are used, and counts the call as failed', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy' })
    const seen = listen(retries, 'success', 'failure')

    await expect(runWith(() => 'busy', retries)).resolves.toBe('busy')
    expect(retries.metrics()).toMatchObject({ successfulCallsWithRetry: 0, failedCallsWithRetry: 1 })
    expect(seen).toEqual([['failure', { name: 'inventory', attempts: 3, result: 'busy' }]])
  })

  it('rejects with ErrMaxRetriesExceeded carrying the last result when told to fail', async () => {
    const retries = retryOf({ retryOnResult: result => result === 'busy', failAfterMaxAttempts: true })
    const seen = listen(retries, 'failure')

    const error = await runWith(() => 'busy', retries).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrMaxRetriesExceeded)
    expect(error).toMatchObject({
      attempts: 3,
      result: 'busy',
      code: 'ERR_MAX_RETRIES_EXCEEDED',
      message: 'Cannot complete "inventory": result still retryable after 3 attempts',
    })
    expect(seen).toEqual([['failure', { name: 'inventory', attempts: 3, result: 'busy' }]])
  })

  // A caller that gave up wants its answer now, not after the remaining attempts.
  it('rejects with the abort reason at once when the caller aborts during a wait, without another attempt', async () => {
    const retries = retryOf({ backoff: 60_000 })
    const seen = listen(retries, 'ignored')
    const { operation, attempts } = flaky(5)
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const call = runWith(operation, retries, controller.signal)
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

    await expect(runWith(operation, retries, controller.signal)).rejects.toThrow('cancelled')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('rejects with ErrInvalidOption when the backoff returns no usable delay', async () => {
    const retries = retryOf({ backoff: () => Number.POSITIVE_INFINITY })

    await expect(runWith(flaky(1).operation, retries)).rejects.toThrow(
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

    await expect(runWith(flaky(1).operation, retries)).rejects.toBe(thrown)
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

    await expect(runWith(() => 'ok', retries)).rejects.toBe(thrown)
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

    await expect(runWith(flaky(1).operation, retries)).rejects.toBe(thrown)
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
      void runWith(
        () => {
          calls++
          if (calls === attempts) {
            return last.promise
          }
          throw new Error('down')
        },
        retryOf({ maxAttempts: attempts }),
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

    void runWith(flaky(1).operation, retries).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647)
    expect(seen[0][1]).toMatchObject({ attempt: 1, delayMs: 2_147_483_647 })
  })

  it('reports each retry before sleeping, then the outcome', async () => {
    const retries = retryOf({ backoff: 25 })
    const seen = listen(retries, 'retry', 'success')
    const { operation } = flaky(1)

    const call = runWith(operation, retries)
    await vi.advanceTimersByTimeAsync(25)
    await call

    expect(seen).toEqual([
      ['retry', { name: 'inventory', attempt: 1, delayMs: 25, error: new Error('failure 1') }],
      ['success', { name: 'inventory', attempts: 2 }],
    ])
  })

  // One count per call, split the way dashboards ask: did it work, and did it need a retry.
  it('counts each call once, by outcome and by whether it needed a retry', async () => {
    const retries = retryOf({ retryOn: error => !(error instanceof TypeError) })

    await runWith(() => 'ok', retries)
    await runWith(flaky(1).operation, retries)
    await runWith(() => {
      throw new TypeError('bad input')
    }, retries).catch(() => undefined)
    await runWith(flaky(9).operation, retries).catch(() => undefined)

    expect(retries.metrics()).toEqual({
      successfulCallsWithoutRetry: 1,
      successfulCallsWithRetry: 1,
      failedCallsWithoutRetry: 1,
      failedCallsWithRetry: 1,
    })
  })

  // A strategy inside the retry that throws before returning a promise is still a failed attempt, not a crash.
  it('counts a synchronous throw from the inner chain as a failed attempt and retries it', async () => {
    const retries = retryOf()
    let calls = 0
    const throwsOnce: Strategy = (ctx, next) => {
      calls++
      if (calls === 1) {
        throw new Error('inner strategy bug')
      }
      return next(ctx)
    }

    await expect(runWith(() => 'ok', retries, throwsOnce)).resolves.toBe('ok')
    expect(calls).toBe(2)
    expect(retries.metrics().successfulCallsWithRetry).toBe(1)
  })

  // `run` is public: a strategy that nests a retry by hand may hand it a `next` the chain never normalised. A
  // synchronous throw from it is still a failed attempt, and a plain value is still a result.
  it('retries a hand-made next that throws synchronously on its first attempt', async () => {
    const retries = retryOf()
    const ctx = { signal: undefined, attempt: 1 } as unknown as ExecutionContext
    let calls = 0
    const throwsOnce: Next<string> = () => {
      calls++
      if (calls === 1) {
        throw new Error('hand-made next bug')
      }
      return Promise.resolve('ok')
    }
    let result: Promise<string> | undefined

    expect(() => {
      result = retries.run(ctx, throwsOnce)
    }).not.toThrow()
    await expect(result).resolves.toBe('ok')
    expect(calls).toBe(2)
    expect(retries.metrics().successfulCallsWithRetry).toBe(1)
  })

  it('counts every attempt of a hand-made next that always throws synchronously', async () => {
    const retries = retryOf({ maxAttempts: 2 })
    const ctx = { signal: undefined, attempt: 1 } as unknown as ExecutionContext
    let calls = 0
    const alwaysThrows: Next<string> = () => {
      calls++
      throw new Error('hand-made next bug')
    }

    await expect(retries.run(ctx, alwaysThrows)).rejects.toThrow('hand-made next bug')
    expect(calls).toBe(2)
    expect(retries.metrics().failedCallsWithRetry).toBe(1)
  })

  it('treats a plain value from a hand-made next as the result', async () => {
    const retries = retryOf()
    const ctx = { signal: undefined, attempt: 1 } as unknown as ExecutionContext
    const plainValue = (() => 'value') as unknown as Next<string>

    await expect(retries.run(ctx, plainValue)).resolves.toBe('value')
    expect(retries.metrics().successfulCallsWithoutRetry).toBe(1)
  })

  it('exposes its name', () => {
    expect(retryOf().name).toBe('inventory')
  })
})
