import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeTimersClock } from '../clock.testkit.js'
import { compose, run } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import type { Operation, Policy } from '../policy.js'
import { unhandledRejections } from '../unhandled.testkit.js'
import {
  circuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerEvents,
  type CircuitBreakerOptions,
  type CircuitBreakerPermit,
  ErrCallNotPermitted,
} from './circuitbreaker.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function breakerOf(options: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
  return circuitBreaker({
    name: 'inventory',
    slidingWindow: { type: 'count', size: 4 },
    minimumNumberOfCalls: 4,
    waitDurationInOpenState: 1_000,
    permittedNumberOfCallsInHalfOpenState: 2,
    clock: fakeTimersClock,
    ...options,
  })
}

function succeed(breaker: CircuitBreaker): Promise<string> {
  return run(breaker.wrap(async () => 'ok'))
}

// Settles with the call's error instead of rejecting, so a test can look at what the caller got.
function fail(breaker: CircuitBreaker, error: unknown = new Error('boom')): Promise<unknown> {
  return run(
    breaker.wrap(async () => {
      throw error
    }),
  ).catch((reason: unknown) => reason)
}

async function trip(breaker: CircuitBreaker): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await fail(breaker)
  }
  expect(breaker.state).toBe('open')
}

// A permit the test expects the breaker to grant.
function permitOf(breaker: CircuitBreaker): CircuitBreakerPermit {
  const permit = breaker.acquire()
  if (permit instanceof ErrCallNotPermitted) {
    throw permit
  }
  return permit
}

// An operation that takes `ms` on the fake clock and then returns.
function slowly(ms: number): () => Promise<string> {
  return async () => {
    vi.advanceTimersByTime(ms)
    return 'ok'
  }
}

function listen<K extends keyof CircuitBreakerEvents>(
  breaker: CircuitBreaker,
  ...types: K[]
): Array<[K, CircuitBreakerEvents[K]]> {
  const seen: Array<[K, CircuitBreakerEvents[K]]> = []
  for (const type of types) {
    breaker.on(type, event => seen.push([type, event]))
  }
  return seen
}

describe('circuitBreaker options', () => {
  it.each([
    [{ failureRateThreshold: 150 }, 'failureRateThreshold must be greater than 0 and at most 100, got 150'],
    [{ slowCallRateThreshold: 0 }, 'slowCallRateThreshold must be greater than 0 and at most 100, got 0'],
    [{ slowCallDurationThreshold: 0 }, 'slowCallDurationThreshold must be a finite Duration of at least 1ms, got 0s'],
    [{ slidingWindow: { type: 'count', size: 0 } }, 'slidingWindow.size must be an integer from 1 to 16777216, got 0'],
    [
      { slidingWindow: { type: 'count', size: 2 ** 24 + 1 } },
      'slidingWindow.size must be an integer from 1 to 16777216, got 16777217',
    ],
    [
      { slidingWindow: { type: 'count', size: Number.MAX_SAFE_INTEGER } },
      'slidingWindow.size must be an integer from 1 to 16777216, got 9007199254740991',
    ],
    [
      { slidingWindow: { type: 'time', duration: 1.5 * Second } },
      'slidingWindow.duration must be a whole number of seconds from 1s to 194d4h20m16s, got 1.5s',
    ],
    [
      { slidingWindow: { type: 'time', duration: (2 ** 24 + 1) * Second } },
      'slidingWindow.duration must be a whole number of seconds from 1s to 194d4h20m16s, got 194d4h20m17s',
    ],
    [
      { slidingWindow: { type: 'calls' } },
      "slidingWindow must be { type: 'count', size } or { type: 'time', duration }",
    ],
    [{ minimumNumberOfCalls: 0 }, 'minimumNumberOfCalls must be an integer of at least 1, got 0'],
    [{ waitDurationInOpenState: -1 }, 'waitDurationInOpenState must be a finite Duration of at least 0s, got -1ms'],
    [
      { permittedNumberOfCallsInHalfOpenState: 0 },
      'permittedNumberOfCallsInHalfOpenState must be an integer from 1 to 16777216, got 0',
    ],
    [
      { permittedNumberOfCallsInHalfOpenState: Number.MAX_SAFE_INTEGER },
      'permittedNumberOfCallsInHalfOpenState must be an integer from 1 to 16777216, got 9007199254740991',
    ],
    [
      { maxWaitDurationInHalfOpenState: Infinity },
      'maxWaitDurationInHalfOpenState must be a finite Duration of at least 0s, got Infinity',
    ],
    [
      { automaticTransitionFromOpenToHalfOpen: 'yes' },
      'automaticTransitionFromOpenToHalfOpen must be a boolean, got string',
    ],
    [{ recordError: true }, 'recordError must be a function or an array of error classes, got a boolean'],
    [{ ignoreError: ['RangeError'] }, 'ignoreError must be a function or an array of error classes, got an object'],
    [{ captureStackTrace: 'yes' }, 'captureStackTrace must be a boolean, got string'],
  ])('rejects %o when the breaker is created, naming the breaker', (options, reason) => {
    expect(() => circuitBreaker({ name: 'inventory', ...(options as object) })).toThrow(ErrInvalidOption)
    expect(() => circuitBreaker({ name: 'inventory', ...(options as object) })).toThrow(
      `Cannot create circuit breaker "inventory": ${reason}`,
    )
  })

  // The maximum is a window the breaker builds: only a larger one is refused, before anything is allocated.
  it.each([
    [{ slidingWindow: { type: 'count', size: 2 ** 24 } }],
    [{ slidingWindow: { type: 'time', duration: 2 ** 24 * Second } }],
    [{ permittedNumberOfCallsInHalfOpenState: 2 ** 24 }],
  ] as const)('accepts the largest window, %o', options => {
    expect(circuitBreaker({ name: 'inventory', ...options }).state).toBe('closed')
  })

  it('requires a name, since events and metrics are keyed on it', () => {
    expect(() => circuitBreaker({ name: '' })).toThrow('Cannot create circuit breaker: name must be a non-empty string')
  })

  it('exposes its name and starts closed', () => {
    const breaker = breakerOf()

    expect(breaker.name).toBe('inventory')
    expect(breaker.state).toBe('closed')
  })
})

describe('circuitBreaker, closed', () => {
  // A handful of failures right after start-up is not evidence that a dependency is down.
  it('stays closed until the window holds the minimum number of calls, however many of them fail', async () => {
    const breaker = breakerOf()

    for (let i = 0; i < 3; i++) {
      await fail(breaker)
    }
    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().failureRate).toBeUndefined()

    await fail(breaker)
    expect(breaker.state).toBe('open')
  })

  it('opens when the failure rate reaches the threshold, not only when it passes it', async () => {
    const breaker = breakerOf({ failureRateThreshold: 50 })

    await succeed(breaker)
    await succeed(breaker)
    await fail(breaker)
    expect(breaker.state).toBe('closed')

    await fail(breaker)
    expect(breaker.state).toBe('open')
  })

  it('stays closed while the failure rate is below the threshold', async () => {
    const breaker = breakerOf({ failureRateThreshold: 50 })

    await succeed(breaker)
    await succeed(breaker)
    await succeed(breaker)
    await fail(breaker)

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().failureRate).toBe(25)
  })

  // A dependency that answers correctly but ever more slowly exhausts callers just as surely as one that fails.
  it('opens on the slow-call rate even when every call succeeds', async () => {
    const breaker = breakerOf({ slowCallRateThreshold: 50, slowCallDurationThreshold: 100 })
    const seen = listen(breaker, 'slowCallRateExceeded')

    await run(breaker.wrap(slowly(150)))
    await run(breaker.wrap(slowly(150)))
    await succeed(breaker)
    await succeed(breaker)

    expect(breaker.state).toBe('open')
    expect(seen).toEqual([['slowCallRateExceeded', { name: 'inventory', slowCallRate: 50 }]])
  })

  it('does not count a call that lasts exactly the slow threshold as slow', async () => {
    const breaker = breakerOf({ slowCallRateThreshold: 50, slowCallDurationThreshold: 100 })

    for (let i = 0; i < 4; i++) {
      await run(breaker.wrap(slowly(100)))
    }

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().slowCalls).toBe(0)
  })

  it('counts an error that recordError declines as a success', async () => {
    const breaker = breakerOf({ recordError: error => !(error instanceof TypeError) })

    for (let i = 0; i < 4; i++) {
      await fail(breaker, new TypeError('bad input'))
    }

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 4, successfulCalls: 4, failedCalls: 0 })
  })

  it('reports an error that recordError declines as a success, with how long the call took', async () => {
    const breaker = breakerOf({ recordError: error => !(error instanceof TypeError) })
    const seen = listen(breaker, 'success', 'failure')

    await run(
      breaker.wrap(async () => {
        vi.advanceTimersByTime(100)
        throw new TypeError('bad input')
      }),
    ).catch(() => undefined)

    expect(seen).toEqual([['success', { name: 'inventory', duration: 100 * Millisecond, slow: false }]])
  })

  // A 503 response is a failure of the dependency even though fetch resolved.
  it('counts a returned value as a failure when recordResult says so, and still hands it to the caller', async () => {
    const breaker = breakerOf({ recordResult: result => result === 'unavailable' })
    const seen = listen(breaker, 'failure')

    for (let i = 0; i < 4; i++) {
      await expect(run(breaker.wrap(async () => 'unavailable'))).resolves.toBe('unavailable')
    }

    expect(breaker.state).toBe('open')
    expect(seen[0]).toEqual(['failure', { name: 'inventory', duration: 0, slow: false, result: 'unavailable' }])
  })

  // A caller's own mistake (a validation error) says nothing about the dependency's health.
  it('ignores the errors ignoreError selects, even when recordError would count them', async () => {
    const breaker = breakerOf({ ignoreError: error => error instanceof RangeError, recordError: () => true })
    const seen = listen(breaker, 'ignored')

    for (let i = 0; i < 6; i++) {
      await fail(breaker, new RangeError('caller bug'))
    }

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(seen).toHaveLength(6)
    expect(seen[0][1]).toMatchObject({ name: 'inventory', reason: 'ignored' })
  })

  it('counts as failures only the errors of the classes recordError lists, subclasses included', async () => {
    class ErrUpstream extends Error {}
    class ErrUpstreamTimeout extends ErrUpstream {}
    const breaker = breakerOf({ recordError: [ErrUpstream] })

    await fail(breaker, new ErrUpstreamTimeout('upstream is slow'))
    await fail(breaker, new ErrUpstream('upstream is down'))
    await fail(breaker, new TypeError('bad input'))

    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 3, failedCalls: 2, successfulCalls: 1 })
  })

  it('ignores the errors of the classes ignoreError lists', async () => {
    const breaker = breakerOf({ ignoreError: [RangeError, SyntaxError] })

    await fail(breaker, new RangeError('caller bug'))
    await fail(breaker, new SyntaxError('caller bug'))
    await fail(breaker, new Error('down'))

    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 1, failedCalls: 1 })
  })

  // A spent quota or a full bulkhead inside the breaker is this process turning the call away: counted as failures,
  // a burst would open the breaker on a healthy dependency.
  it('ignores a refusal from a policy inside it, whatever recordError says', async () => {
    const breaker = breakerOf({ recordError: () => true })
    const seen = listen(breaker, 'ignored', 'failure')
    const refusal = new ErrCallRefused('Cannot call "inventory": queue is full', 'ERR_QUEUE_FULL', undefined)

    await expect(
      run(
        breaker.wrap(async () => {
          throw refusal
        }),
      ),
    ).rejects.toBe(refusal)

    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 0, failedCalls: 0 })
    expect(seen).toEqual([['ignored', { name: 'inventory', duration: 0, error: refusal, reason: 'refused' }]])
  })

  // A caller that gave up is not a dependency that failed.
  it('ignores a failure that settles after the caller aborted', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'ignored', 'failure')
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const call = run(
      breaker.wrap(
        async ({ signal }) =>
          new Promise((_, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason))
          }),
      ),
      controller.signal,
    )
    controller.abort(reason)

    await expect(call).rejects.toBe(reason)
    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(seen).toEqual([['ignored', { name: 'inventory', duration: 0, error: reason, reason: 'aborted' }]])
  })

  it('forgets failures older than a time window', async () => {
    const breaker = breakerOf({ slidingWindow: { type: 'time', duration: 10 * Second } })

    for (let i = 0; i < 3; i++) {
      await fail(breaker)
    }
    vi.advanceTimersByTime(11_000)
    await fail(breaker)
    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().bufferedCalls).toBe(1)

    for (let i = 0; i < 3; i++) {
      await fail(breaker)
    }
    expect(breaker.state).toBe('open')
  })

  // A dashboard reading the breaker after a quiet spell must not keep showing failures that left the window.
  it('reports an empty window once an idle gap outlasts a time window', async () => {
    const breaker = breakerOf({
      slidingWindow: { type: 'time', duration: 2 * Second },
      minimumNumberOfCalls: 2,
      failureRateThreshold: 100,
    })
    await fail(breaker)
    await succeed(breaker)
    await succeed(breaker)

    vi.advanceTimersByTime(5_000)

    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 0, failureRate: undefined })
  })
})

describe('circuitBreaker, open', () => {
  it('refuses calls without running them, with an ErrCallNotPermitted that says how long to wait', async () => {
    const breaker = breakerOf()
    await trip(breaker)
    const seen = listen(breaker, 'notPermitted')
    const operation = vi.fn(async () => 'ok')
    vi.advanceTimersByTime(400)

    const refused = await run(breaker.wrap(operation)).catch((error: unknown) => error)

    expect(operation).not.toHaveBeenCalled()
    expect(refused).toBeInstanceOf(ErrCallNotPermitted)
    // The kind every refusal shares, which retry never retries and an HTTP layer answers with 503.
    expect(refused).toBeInstanceOf(ErrCallRefused)
    expect(refused).toMatchObject({
      breaker: 'inventory',
      state: 'open',
      retryAfter: 600,
      code: 'ERR_CALL_NOT_PERMITTED',
      message: 'Cannot call "inventory": circuit breaker is open',
    })
    expect(seen).toEqual([['notPermitted', { name: 'inventory', state: 'open' }]])
    expect(breaker.metrics().notPermittedCalls).toBe(1)
  })

  it('stays open after the wait until a call arrives, and lets that call through as a trial', async () => {
    const breaker = breakerOf()
    await trip(breaker)

    vi.advanceTimersByTime(1_000)
    expect(breaker.state).toBe('open')

    await expect(succeed(breaker)).resolves.toBe('ok')
    expect(breaker.state).toBe('half_open')
  })

  it('moves to half open by itself when the wait elapses, if told to', async () => {
    const breaker = breakerOf({ automaticTransitionFromOpenToHalfOpen: true })
    await trip(breaker)
    const seen = listen(breaker, 'stateChange')

    vi.advanceTimersByTime(999)
    expect(breaker.state).toBe('open')
    vi.advanceTimersByTime(1)

    expect(breaker.state).toBe('half_open')
    expect(seen).toEqual([['stateChange', { name: 'inventory', from: 'open', to: 'half_open' }]])
  })

  it('cancels the automatic move to half open when the breaker is forced open', async () => {
    const breaker = breakerOf({ automaticTransitionFromOpenToHalfOpen: true })
    await trip(breaker)

    breaker.forceOpen()
    vi.advanceTimersByTime(5_000)

    expect(breaker.state).toBe('forced_open')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('circuitBreaker, half open', () => {
  async function halfOpen(breaker: CircuitBreaker): Promise<void> {
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
  }

  it('refuses calls beyond the permitted trial calls', async () => {
    const breaker = breakerOf()
    await halfOpen(breaker)
    const hung = Promise.withResolvers<string>()

    const trials = [run(breaker.wrap(async () => hung.promise)), run(breaker.wrap(async () => hung.promise))]
    const refused = await succeed(breaker).catch((error: unknown) => error)

    expect(refused).toMatchObject({
      state: 'half_open',
      retryAfter: undefined,
      message: 'Cannot call "inventory": circuit breaker is half open and every trial call is in use',
    })
    hung.resolve('ok')
    await Promise.all(trials)
    expect(breaker.state).toBe('closed')
  })

  it('closes once the trial calls succeed, with an empty window', async () => {
    const breaker = breakerOf()
    await halfOpen(breaker)

    await succeed(breaker)
    await succeed(breaker)

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().bufferedCalls).toBe(0)
  })

  it('opens again when the trial calls fail at the threshold rate', async () => {
    const breaker = breakerOf()
    await halfOpen(breaker)

    await succeed(breaker)
    await fail(breaker)

    expect(breaker.state).toBe('open')
  })

  it('reports the trial calls in metrics while half open', async () => {
    const breaker = breakerOf()
    await halfOpen(breaker)

    await fail(breaker)

    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 1, failedCalls: 1, failureRate: undefined })
  })

  // A dependency that keeps failing its trials should be left alone for longer each time.
  it('lengthens the wait with each consecutive opening, and starts over once closed', async () => {
    const breaker = breakerOf({ waitDurationInOpenState: openCount => openCount * 1_000 })
    const retryAfter = async (): Promise<unknown> =>
      ((await succeed(breaker).catch((error: unknown) => error)) as ErrCallNotPermitted).retryAfter

    await trip(breaker)
    expect(await retryAfter()).toBe(1_000)

    vi.advanceTimersByTime(1_000)
    await fail(breaker)
    await fail(breaker)
    expect(await retryAfter()).toBe(2_000)

    vi.advanceTimersByTime(2_000)
    await succeed(breaker)
    await succeed(breaker)
    expect(breaker.state).toBe('closed')

    await trip(breaker)
    expect(await retryAfter()).toBe(1_000)
  })

  // Trial calls that never settle would otherwise hold every permit forever, and the breaker with them.
  it('re-opens after the maximum half-open wait even while hung trial calls hold every permit', async () => {
    const breaker = breakerOf({ maxWaitDurationInHalfOpenState: 500, permittedNumberOfCallsInHalfOpenState: 1 })
    await halfOpen(breaker)
    const hung = Promise.withResolvers<string>()
    const trial = run(breaker.wrap(async () => hung.promise))

    vi.advanceTimersByTime(500)
    const refused = await succeed(breaker).catch((error: unknown) => error)

    expect(refused).toMatchObject({ state: 'open', retryAfter: 1_000 })
    expect(breaker.state).toBe('open')

    hung.resolve('late')
    await trial
    expect(breaker.state).toBe('open')
  })

  // Time spent half open with a free trial slot says nothing about the dependency; a healthy one must get its trial.
  it('lets the first call after an idle half-open period through as a trial', async () => {
    const breaker = breakerOf({
      automaticTransitionFromOpenToHalfOpen: true,
      maxWaitDurationInHalfOpenState: 500,
      permittedNumberOfCallsInHalfOpenState: 1,
    })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    expect(breaker.state).toBe('half_open')

    vi.advanceTimersByTime(60_000)

    await expect(succeed(breaker)).resolves.toBe('ok')
    expect(breaker.state).toBe('closed')
  })

  // The automatic transition matters here: without it, the trial itself enters half open and idle time never passes.
  it('measures the maximum half-open wait from the last trial admitted', async () => {
    const breaker = breakerOf({
      automaticTransitionFromOpenToHalfOpen: true,
      maxWaitDurationInHalfOpenState: 500,
      permittedNumberOfCallsInHalfOpenState: 1,
    })
    await trip(breaker)
    vi.advanceTimersByTime(11_000)
    const hung = Promise.withResolvers<string>()
    const trial = run(breaker.wrap(async () => hung.promise))

    vi.advanceTimersByTime(499)
    expect(await succeed(breaker).catch((error: unknown) => error)).toMatchObject({ state: 'half_open' })

    vi.advanceTimersByTime(1)
    expect(await succeed(breaker).catch((error: unknown) => error)).toMatchObject({
      state: 'open',
      retryAfter: 1_000,
    })

    hung.resolve('late')
    await trial
  })

  // A listener that moves the breaker is obeyed: the call is decided by the state the breaker ends up in.
  it('runs the call when a stateChange listener resets the breaker as the half-open wait expires', async () => {
    const breaker = breakerOf({ maxWaitDurationInHalfOpenState: 500, permittedNumberOfCallsInHalfOpenState: 1 })
    await halfOpen(breaker)
    const hung = Promise.withResolvers<string>()
    const trial = run(breaker.wrap(async () => hung.promise))
    breaker.on('stateChange', event => {
      if (event.to === 'open') {
        breaker.reset()
      }
    })

    vi.advanceTimersByTime(500)

    await expect(succeed(breaker)).resolves.toBe('ok')
    expect(breaker.state).toBe('closed')
    hung.resolve('late')
    await trial
  })

  it('gives the trial slot back when a trial call is ignored', async () => {
    const breaker = breakerOf({
      permittedNumberOfCallsInHalfOpenState: 1,
      ignoreError: error => error instanceof RangeError,
    })
    await halfOpen(breaker)

    await fail(breaker, new RangeError('caller bug'))
    expect(breaker.state).toBe('half_open')

    await succeed(breaker)
    expect(breaker.state).toBe('closed')
  })
})

describe('circuitBreaker, client errors', () => {
  class ErrNotFound extends Error {}
  const isClientError = (error: unknown): boolean => error instanceof ErrNotFound

  // Calls the breaker as an entrypoint's transport does: the context says which errors are the client's own answer.
  function failForClient(breaker: CircuitBreaker, error: unknown, classify = isClientError): Promise<unknown> {
    const op = breaker.wrap(async () => {
      throw error
    })
    return op({ signal: undefined, isClientError: classify }, undefined).catch((reason: unknown) => reason)
  }

  // A burst of requests for records that do not exist says nothing about the dependency: counted, it would open the
  // breaker for every client.
  it('records an error the context calls a client error as ignored, so a burst of them never opens it', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'ignored', 'failure', 'success')
    const missing = new ErrNotFound('no such record')

    for (let i = 0; i < 100; i++) {
      expect(await failForClient(breaker, missing)).toBe(missing)
    }

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 0, failedCalls: 0, successfulCalls: 0 })
    expect(seen).toHaveLength(100)
    expect(seen[0]).toEqual(['ignored', { name: 'inventory', duration: 0, error: missing, reason: 'ignored' }])
  })

  it('still counts an error the context does not call a client error', async () => {
    const breaker = breakerOf()

    for (let i = 0; i < 4; i++) {
      await failForClient(breaker, new Error('down'))
    }

    expect(breaker.state).toBe('open')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 4, failedCalls: 4 })
  })

  it('gives the trial slot back in half open, and neither closes nor reopens the breaker', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)

    await failForClient(breaker, new ErrNotFound('no such record'))
    expect(breaker.state).toBe('half_open')

    await succeed(breaker)
    expect(breaker.state).toBe('closed')
  })

  it('rejects the call with the error the classification threw, and records nothing', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    const broken = new Error('classification bug')
    await trip(breaker)
    vi.advanceTimersByTime(1_000)

    const error = await failForClient(breaker, new Error('down'), () => {
      throw broken
    })

    expect(error).toBe(broken)
    expect(breaker.state).toBe('half_open')
    expect(breaker.metrics().bufferedCalls).toBe(0)
    await succeed(breaker)
    expect(breaker.state).toBe('closed')
  })
})

describe('circuitBreaker, late results', () => {
  // The outcome of a call belongs to the state it started in; counting it later would judge the wrong period.
  it('does not record a call that settles after the breaker opened, but still reports it', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'success')
    const slow = Promise.withResolvers<string>()
    const call = run(breaker.wrap(async () => slow.promise))

    await trip(breaker)
    slow.resolve('ok')
    await call

    expect(breaker.state).toBe('open')
    expect(breaker.metrics().bufferedCalls).toBe(4)
    expect(seen).toHaveLength(1)
  })

  it('does not record a call that settles after a reset, but still reports it', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'failure')
    const slow = Promise.withResolvers<string>()
    const call = run(breaker.wrap(async () => slow.promise)).catch(() => undefined)

    breaker.reset()
    slow.reject(new Error('boom'))
    await call

    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(seen).toHaveLength(1)
  })
})

describe('circuitBreaker, manual control', () => {
  it('refuses every call while forced open, with no retry-after, until reset', async () => {
    const breaker = breakerOf()

    breaker.forceOpen()
    const refused = await succeed(breaker).catch((error: unknown) => error)
    vi.advanceTimersByTime(60_000)

    expect(refused).toMatchObject({
      state: 'forced_open',
      retryAfter: undefined,
      message: 'Cannot call "inventory": circuit breaker is forced open',
    })
    expect(breaker.state).toBe('forced_open')

    breaker.reset()
    await expect(succeed(breaker)).resolves.toBe('ok')
  })

  it('lets every call through and records nothing while disabled', async () => {
    const breaker = breakerOf()
    await trip(breaker)
    const seen = listen(breaker, 'success', 'failure', 'ignored')

    breaker.disable()
    for (let i = 0; i < 6; i++) {
      expect(await fail(breaker)).toMatchObject({ message: 'boom' })
    }
    await succeed(breaker)

    expect(breaker.state).toBe('disabled')
    expect(breaker.metrics().bufferedCalls).toBe(4)
    expect(seen).toEqual([])
  })

  it('records and reports a crossed threshold once, but never opens, in metrics-only mode', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'failureRateExceeded', 'stateChange')

    breaker.metricsOnly()
    for (let i = 0; i < 8; i++) {
      await fail(breaker)
    }

    expect(breaker.state).toBe('metrics_only')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 4, failureRate: 100 })
    expect(seen).toEqual([
      ['stateChange', { name: 'inventory', from: 'closed', to: 'metrics_only' }],
      ['failureRateExceeded', { name: 'inventory', failureRate: 100 }],
    ])
  })

  // In metrics-only mode the rate events are the alert. A rate that fell away with an emptied window and came back
  // is a new crossing.
  it('reports a threshold crossed again after a time window emptied, in metrics-only mode', async () => {
    const breaker = breakerOf({
      slidingWindow: { type: 'time', duration: 1 * Second },
      minimumNumberOfCalls: 2,
      failureRateThreshold: 50,
    })
    const seen = listen(breaker, 'failureRateExceeded')
    breaker.metricsOnly()

    await fail(breaker)
    await fail(breaker)
    vi.advanceTimersByTime(2_100)
    await fail(breaker)
    await fail(breaker)

    expect(seen).toEqual([
      ['failureRateExceeded', { name: 'inventory', failureRate: 100 }],
      ['failureRateExceeded', { name: 'inventory', failureRate: 100 }],
    ])
  })

  // The refused-calls count feeds a monotonic counter; a reset that lowered it would read as a counter reset.
  it('clears the window on reset but keeps the lifetime count of refused calls', async () => {
    const breaker = breakerOf()
    await trip(breaker)
    await fail(breaker)
    await fail(breaker)
    const seen = listen(breaker, 'stateChange', 'reset')

    breaker.reset()

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 0, notPermittedCalls: 2 })
    expect(seen).toEqual([
      ['stateChange', { name: 'inventory', from: 'open', to: 'closed' }],
      ['reset', { name: 'inventory' }],
    ])
  })
})

describe('circuitBreaker, manual transitions', () => {
  // An operator who knows the dependency is down, from a deploy or a status page, opens it before calls fail.
  it('opens on transitionToOpen for the configured wait, then lets a trial call through', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'stateChange')

    breaker.transitionToOpen()

    expect(await succeed(breaker).catch((error: unknown) => error)).toMatchObject({ state: 'open', retryAfter: 1_000 })
    vi.advanceTimersByTime(1_000)
    await succeed(breaker)
    expect(breaker.state).toBe('half_open')
    expect(seen).toEqual([
      ['stateChange', { name: 'inventory', from: 'closed', to: 'open' }],
      ['stateChange', { name: 'inventory', from: 'open', to: 'half_open' }],
    ])
  })

  it('stays open for the wait transitionToOpen names instead of the configured one', async () => {
    const breaker = breakerOf({ automaticTransitionFromOpenToHalfOpen: true })

    breaker.transitionToOpen({ for: 5 * Second })

    expect(await succeed(breaker).catch((error: unknown) => error)).toMatchObject({ state: 'open', retryAfter: 5_000 })
    vi.advanceTimersByTime(4_999)
    expect(breaker.state).toBe('open')
    vi.advanceTimersByTime(1)
    expect(breaker.state).toBe('half_open')
  })

  // A manual opening is an opening: the backoff of the next one starts from it.
  it('counts a manual opening towards the next wait of a backoff', async () => {
    const breaker = breakerOf({ waitDurationInOpenState: openCount => openCount * 1_000 })

    breaker.transitionToOpen({ for: 10 * Second })
    breaker.transitionToHalfOpen()
    await fail(breaker)
    await fail(breaker)

    expect(await succeed(breaker).catch((error: unknown) => error)).toMatchObject({ state: 'open', retryAfter: 2_000 })
  })

  it.each([
    [-1, 'got -1ms'],
    [Infinity, 'got Infinity'],
  ])('refuses a for of %s and leaves the breaker as it was', (wait, got) => {
    const breaker = breakerOf()

    expect(() => breaker.transitionToOpen({ for: wait })).toThrow(ErrInvalidOption)
    expect(() => breaker.transitionToOpen({ for: wait })).toThrow(
      `Cannot open circuit breaker "inventory": for must be a finite Duration of at least 0s, ${got}`,
    )
    expect(breaker.state).toBe('closed')
  })

  it('lets trial calls through at once on transitionToHalfOpen, and closes on their success', async () => {
    const breaker = breakerOf()
    await trip(breaker)

    breaker.transitionToHalfOpen()
    await succeed(breaker)
    await succeed(breaker)

    expect(breaker.state).toBe('closed')
  })

  // The trials decide whether the dependency recovered; a call that started before them knows nothing about that.
  it('does not count a call that started before transitionToHalfOpen as a trial', async () => {
    const breaker = breakerOf()
    const late = Promise.withResolvers<string>()
    const call = run(breaker.wrap(() => late.promise))

    breaker.transitionToHalfOpen()
    late.resolve('ok')
    await call
    await succeed(breaker)

    expect(breaker.state).toBe('half_open')
    expect(breaker.metrics().bufferedCalls).toBe(1)
  })

  it('closes and forgets the window on transitionToClosed, without the reset event', async () => {
    const breaker = breakerOf()
    await trip(breaker)
    const seen = listen(breaker, 'stateChange', 'reset')

    breaker.transitionToClosed()

    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(seen).toEqual([['stateChange', { name: 'inventory', from: 'open', to: 'closed' }]])
  })
})

describe('circuitBreaker, acquire', () => {
  // A streamed body fails after the response started, outside any operation a wrapper could watch.
  it('records the permits settled by hand, and refuses once they open it', () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'notPermitted')

    for (let i = 0; i < 4; i++) {
      permitOf(breaker).onError(new Error('stream reset'))
    }
    const refused = breaker.acquire()

    expect(breaker.state).toBe('open')
    expect(refused).toBeInstanceOf(ErrCallNotPermitted)
    expect(refused).toMatchObject({ breaker: 'inventory', state: 'open', retryAfter: 1_000 })
    expect(seen).toEqual([['notPermitted', { name: 'inventory', state: 'open' }]])
    expect(breaker.metrics().notPermittedCalls).toBe(1)
  })

  it('measures a permit from acquire to its settlement', () => {
    const breaker = breakerOf({ slowCallDurationThreshold: 100 * Millisecond })
    const seen = listen(breaker, 'success')

    const permit = permitOf(breaker)
    vi.advanceTimersByTime(150)
    permit.onSuccess()

    expect(seen).toEqual([['success', { name: 'inventory', duration: 150, slow: true }]])
  })

  it('records a permit once, however often it is settled', () => {
    const breaker = breakerOf()

    const permit = permitOf(breaker)
    permit.onError(new Error('down'))
    permit.onError(new Error('down'))
    permit.onSuccess()
    permit.release()

    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 1, failedCalls: 1 })
  })

  it('judges a result with recordResult, and never a success reported without one', () => {
    const recordResult = vi.fn((result: unknown) => result === 503)
    const breaker = breakerOf({ recordResult })

    permitOf(breaker).onResult(503)
    permitOf(breaker).onSuccess()

    expect(recordResult).toHaveBeenCalledTimes(1)
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 2, failedCalls: 1 })
  })

  it('ignores the errors handed to onError that it ignores for a wrapped call', () => {
    const breaker = breakerOf({ ignoreError: [RangeError] })
    const seen = listen(breaker, 'ignored')

    permitOf(breaker).onError(new RangeError('caller bug'))
    permitOf(breaker).onError(new ErrCallRefused('Cannot call "inventory": queue is full', 'ERR_QUEUE_FULL', undefined))

    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(seen.map(([, event]) => event.reason)).toEqual(['ignored', 'refused'])
  })

  // A caller that leaves mid-stream says nothing about the dependency, and must not hold a trial slot forever.
  it('gives its trial slot back once, and records nothing, when a permit is released', async () => {
    const breaker = breakerOf()
    await trip(breaker)
    vi.advanceTimersByTime(1_000)

    const left = permitOf(breaker)
    permitOf(breaker)
    left.release()
    left.release()

    expect(breaker.acquire()).not.toBeInstanceOf(ErrCallNotPermitted)
    expect(breaker.acquire()).toBeInstanceOf(ErrCallNotPermitted)
    expect(breaker.metrics().bufferedCalls).toBe(0)
  })

  it('reports nothing for a permit acquired while disabled', () => {
    const breaker = breakerOf()
    breaker.disable()
    const seen = listen(breaker, 'success', 'failure')

    permitOf(breaker).onError(new Error('down'))
    permitOf(breaker).onSuccess()

    expect(seen).toEqual([])
  })

  it('throws what a predicate threw from the permit method that ran it, and records nothing', () => {
    const thrown = new Error('predicate bug')
    const breaker = breakerOf({
      recordError: () => {
        throw thrown
      },
    })
    const permit = permitOf(breaker)

    expect(() => permit.onError(new Error('down'))).toThrow(thrown)
    expect(breaker.metrics().bufferedCalls).toBe(0)
  })
})

describe('circuitBreaker, dispose', () => {
  it('cancels the automatic move to half open, and moves on the first call after the wait instead', async () => {
    const breaker = breakerOf({ automaticTransitionFromOpenToHalfOpen: true })
    await trip(breaker)

    breaker.dispose()
    vi.advanceTimersByTime(5_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(breaker.state).toBe('open')
    await succeed(breaker)
    expect(breaker.state).toBe('half_open')
  })

  it('sets no timer when it opens after dispose', async () => {
    const breaker = breakerOf({ automaticTransitionFromOpenToHalfOpen: true })
    breaker.dispose()

    await trip(breaker)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('is what a using declaration calls at the end of its block', async () => {
    {
      using breaker = breakerOf({ automaticTransitionFromOpenToHalfOpen: true })
      await trip(breaker)
      expect(vi.getTimerCount()).toBe(1)
    }

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('circuitBreaker, events', () => {
  it('reports the outcome, then the rate that tripped the breaker, then the state change', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'failure', 'failureRateExceeded', 'stateChange')

    await trip(breaker)

    expect(seen.map(([type]) => type)).toEqual([
      'failure',
      'failure',
      'failure',
      'failure',
      'failureRateExceeded',
      'stateChange',
    ])
    expect(seen[4][1]).toEqual({ name: 'inventory', failureRate: 100 })
    expect(seen[5][1]).toEqual({ name: 'inventory', from: 'closed', to: 'open' })
  })

  it('lets a stateChange listener move the breaker again from inside the transition', async () => {
    const breaker = breakerOf()
    breaker.on('stateChange', event => {
      if (event.to === 'open') {
        breaker.reset()
      }
    })

    for (let i = 0; i < 4; i++) {
      await fail(breaker)
    }
    await succeed(breaker)

    expect(breaker.state).toBe('closed')
    expect(breaker.metrics().bufferedCalls).toBe(1)
  })
})

describe('circuitBreaker, failing predicates and wait functions', () => {
  it('rejects the call with the error a predicate threw, and records nothing', async () => {
    const broken = new Error('predicate bug')
    const breaker = breakerOf({
      recordResult: () => {
        throw broken
      },
    })

    await expect(succeed(breaker)).rejects.toBe(broken)
    expect(breaker.metrics().bufferedCalls).toBe(0)
  })

  it('gives the trial slot back when a predicate throws in half open', async () => {
    const breaker = breakerOf({
      permittedNumberOfCallsInHalfOpenState: 1,
      recordResult: result => {
        if (result === 'explode') {
          throw new Error('predicate bug')
        }
        return false
      },
    })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)

    await expect(run(breaker.wrap(async () => 'explode'))).rejects.toThrow('predicate bug')
    expect(breaker.state).toBe('half_open')

    await succeed(breaker)
    expect(breaker.state).toBe('closed')
  })

  it('stays closed and rejects the tripping call when the wait function returns no usable delay', async () => {
    const breaker = breakerOf({ waitDurationInOpenState: () => Number.NaN })

    for (let i = 0; i < 3; i++) {
      await fail(breaker)
    }
    const tripping = await fail(breaker)

    expect(tripping).toBeInstanceOf(ErrInvalidOption)
    expect(tripping).toMatchObject({
      message: 'Cannot schedule the open state of circuit breaker "inventory": delay must be a finite number, got NaN',
    })
    expect(breaker.state).toBe('closed')
  })
})

describe('circuitBreaker, refusal cost', () => {
  // Refusals arrive in bulk while a dependency is down; a stack says nothing the error's fields do not.
  it('refuses without capturing a stack trace unless asked to', async () => {
    const plain = breakerOf()
    const capturing = breakerOf({ captureStackTrace: true })
    plain.forceOpen()
    capturing.forceOpen()

    const withoutStack = (await succeed(plain).catch((error: unknown) => error)) as Error
    const withStack = (await succeed(capturing).catch((error: unknown) => error)) as Error

    expect(withoutStack.stack?.split('\n')).toEqual([
      'ErrCallNotPermitted: Cannot call "inventory": circuit breaker is forced open',
    ])
    expect(withStack.stack?.split('\n').length).toBeGreaterThan(1)
  })

  // A stack is captured only when asked for, and then its few frames must lead to the caller, not to the breaker's
  // bookkeeping.
  it("starts a captured refusal's stack in the breaker, directly under the caller's entry", async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      const breaker = breakerOf({ captureStackTrace: true })
      breaker.forceOpen()
      const guarded = breaker.wrap(async () => 'ok')
      function callsTheOpenBreaker(): Promise<string> {
        return guarded({ signal: undefined }, undefined)
      }

      const refused = (await callsTheOpenBreaker().catch((error: unknown) => error)) as Error
      const frames = refused.stack?.split('\n').slice(1) ?? []
      const caller = frames.findIndex(frame => frame.includes('callsTheOpenBreaker'))

      expect(frames[0]).toContain('CircuitBreaker')
      expect(caller).toBe(2)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })

  // The limit is process-wide: a refusal that left it at 0 would strip the stack from every later error.
  it('leaves Error.stackTraceLimit as it found it', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 7
    try {
      const breaker = breakerOf()
      breaker.forceOpen()

      await succeed(breaker).catch(() => undefined)

      expect(errorClass.stackTraceLimit).toBe(7)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })

  it('hands a refusal back as a rejected promise, never as a throw', async () => {
    const breaker = breakerOf()
    breaker.forceOpen()
    let returned: Promise<number> | undefined

    expect(() => {
      returned = breaker.wrap(() => Promise.resolve(1))({ signal: undefined }, undefined)
    }).not.toThrow()
    await expect(returned).rejects.toBeInstanceOf(ErrCallNotPermitted)
  })

  // Without this, a trial whose inner layer throws before returning a promise would hold its slot forever.
  it('records a trial call whose inner layer throws synchronously as a failure', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const throwing: Policy = () => () => {
      throw new Error('inner layer bug')
    }

    await expect(run(compose(breaker, throwing)(async () => 'ok'))).rejects.toThrow('inner layer bug')

    expect(breaker.state).toBe('open')
  })

  it('records a trial call whose inner layer returns a plain value as a success', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const plainValue = (() => () => 42) as unknown as Policy

    await expect(run(compose(breaker, plainValue)(async () => 'ok'))).resolves.toBe(42)

    expect(breaker.state).toBe('closed')
  })
})

// `wrap` is public: an operation wrapped by hand may throw synchronously or return a plain value. Whatever it does, the
// call is recorded, its trial slot is settled, and the caller gets a promise.
describe('circuitBreaker, wrap called by hand', () => {
  const ctx = { signal: undefined }

  it('records a trial call as a failure when an operation wrapped by hand throws synchronously', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const throwing = (() => {
      throw new Error('hand-made operation bug')
    }) as Operation<never>
    let result: Promise<unknown> | undefined

    expect(() => {
      result = breaker.wrap(throwing)(ctx, undefined)
    }).not.toThrow()
    await expect(result).rejects.toThrow('hand-made operation bug')

    expect(breaker.state).toBe('open')
  })

  it('records a trial call as a success when an operation wrapped by hand returns a plain value', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const plainValue = (() => 42) as unknown as Operation<number>

    await expect(breaker.wrap(plainValue)(ctx, undefined)).resolves.toBe(42)

    expect(breaker.state).toBe('closed')
  })

  it('hands a synchronous throw from an operation wrapped by hand back as a rejection while disabled', async () => {
    const breaker = breakerOf()
    breaker.disable()
    const throwing = (() => {
      throw new Error('hand-made operation bug')
    }) as Operation<never>
    let result: Promise<unknown> | undefined

    expect(() => {
      result = breaker.wrap(throwing)(ctx, undefined)
    }).not.toThrow()
    await expect(result).rejects.toThrow('hand-made operation bug')
  })

  // A wait function that throws while the breaker re-opens must reach the caller as a rejection, like every failure.
  it('hands a failing wait function back as a rejection when a call re-opens the breaker', async () => {
    const breaker = breakerOf({
      maxWaitDurationInHalfOpenState: 500,
      permittedNumberOfCallsInHalfOpenState: 1,
      waitDurationInOpenState: openings => {
        if (openings > 1) {
          throw new Error('bad wait')
        }
        return 1_000
      },
    })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    void breaker.wrap(() => new Promise<number>(() => undefined))(ctx, undefined)
    vi.advanceTimersByTime(500)
    let returned: Promise<number> | undefined

    expect(() => {
      returned = breaker.wrap(() => Promise.resolve(1))(ctx, undefined)
    }).not.toThrow()
    await expect(returned).rejects.toThrow('bad wait')
  })
})

describe('circuitBreaker, unhandled rejections', () => {
  // Every way a call can end must settle the caller's promise and leave no other one rejected behind it.
  it('leaves no rejection unhandled, whichever way a call ends', async () => {
    const reasons = await unhandledRejections(async () => {
      const forced = breakerOf()
      forced.forceOpen()
      const disabled = breakerOf()
      disabled.disable()
      const judging = breakerOf({
        recordResult: () => {
          throw new Error('predicate bug')
        },
      })
      const reopening = breakerOf({
        waitDurationInOpenState: () => {
          throw new Error('wait bug')
        },
      })
      const caller = new AbortController()
      const down = async (): Promise<string> => {
        throw new Error('down')
      }

      const calls = [
        run(forced.wrap(async () => 'ok')),
        run(breakerOf().wrap(down)),
        run(judging.wrap(async () => 'ok')),
        run(
          disabled.wrap(() => {
            throw new Error('sync')
          }),
        ),
        run(
          breakerOf().wrap(async () => {
            caller.abort()
            throw new Error('down')
          }),
          caller.signal,
        ),
        ...Array.from({ length: 4 }, () => run(reopening.wrap(down))),
      ].map(call => call.catch(() => undefined))
      await Promise.all(calls)
    })

    expect(reasons).toEqual([])
  })
})
