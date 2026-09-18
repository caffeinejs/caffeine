import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compose, runWith } from '../compose.js'
import { ErrCallNotPermitted, ErrInvalidOption } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import type { ExecutionContext, Next, Strategy } from '../strategy.js'
import {
  circuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerEvents,
  type CircuitBreakerOptions,
} from './circuit_breaker.js'

beforeEach(() => {
  useFakeClock()
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
    waitDurationInOpenStateMs: 1_000,
    permittedNumberOfCallsInHalfOpenState: 2,
    ...options,
  })
}

function succeed(breaker: CircuitBreaker): Promise<string> {
  return runWith(() => 'ok', breaker)
}

// Settles with the call's error instead of rejecting, so a test can look at what the caller got.
function fail(breaker: CircuitBreaker, error: unknown = new Error('boom')): Promise<unknown> {
  return runWith(() => {
    throw error
  }, breaker).catch((reason: unknown) => reason)
}

async function trip(breaker: CircuitBreaker): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await fail(breaker)
  }
  expect(breaker.state).toBe('open')
}

// An operation that takes `ms` on the fake clock and then returns.
function slowly(ms: number): () => string {
  return () => {
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
    [{ slowCallDurationThresholdMs: 0 }, 'slowCallDurationThresholdMs must be a finite number of at least 1, got 0'],
    [{ slidingWindow: { type: 'count', size: 0 } }, 'slidingWindow.size must be an integer of at least 1, got 0'],
    [
      { slidingWindow: { type: 'time', seconds: 1.5 } },
      'slidingWindow.seconds must be an integer of at least 1, got 1.5',
    ],
    [
      { slidingWindow: { type: 'calls' } },
      "slidingWindow must be { type: 'count', size } or { type: 'time', seconds }",
    ],
    [{ minimumNumberOfCalls: 0 }, 'minimumNumberOfCalls must be an integer of at least 1, got 0'],
    [{ waitDurationInOpenStateMs: -1 }, 'waitDurationInOpenStateMs must be a finite number of at least 0, got -1'],
    [
      { permittedNumberOfCallsInHalfOpenState: 0 },
      'permittedNumberOfCallsInHalfOpenState must be an integer of at least 1, got 0',
    ],
    [
      { maxWaitDurationInHalfOpenStateMs: Infinity },
      'maxWaitDurationInHalfOpenStateMs must be a finite number of at least 0, got Infinity',
    ],
    [
      { automaticTransitionFromOpenToHalfOpen: 'yes' },
      'automaticTransitionFromOpenToHalfOpen must be a boolean, got string',
    ],
    [{ recordError: true }, 'recordError must be a function, got boolean'],
    [{ captureStackTrace: 'yes' }, 'captureStackTrace must be a boolean, got string'],
  ])('rejects %o when the breaker is created, naming the breaker', (options, reason) => {
    expect(() => circuitBreaker({ name: 'inventory', ...(options as object) })).toThrow(ErrInvalidOption)
    expect(() => circuitBreaker({ name: 'inventory', ...(options as object) })).toThrow(
      `Cannot create circuit breaker "inventory": ${reason}`,
    )
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
    const breaker = breakerOf({ slowCallRateThreshold: 50, slowCallDurationThresholdMs: 100 })
    const seen = listen(breaker, 'slowCallRateExceeded')

    await runWith(slowly(150), breaker)
    await runWith(slowly(150), breaker)
    await succeed(breaker)
    await succeed(breaker)

    expect(breaker.state).toBe('open')
    expect(seen).toEqual([['slowCallRateExceeded', { name: 'inventory', slowCallRate: 50 }]])
  })

  it('does not count a call that lasts exactly the slow threshold as slow', async () => {
    const breaker = breakerOf({ slowCallRateThreshold: 50, slowCallDurationThresholdMs: 100 })

    for (let i = 0; i < 4; i++) {
      await runWith(slowly(100), breaker)
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

  // A 503 response is a failure of the dependency even though fetch resolved.
  it('counts a returned value as a failure when recordResult says so, and still hands it to the caller', async () => {
    const breaker = breakerOf({ recordResult: result => result === 'unavailable' })
    const seen = listen(breaker, 'failure')

    for (let i = 0; i < 4; i++) {
      await expect(runWith(() => 'unavailable', breaker)).resolves.toBe('unavailable')
    }

    expect(breaker.state).toBe('open')
    expect(seen[0]).toEqual(['failure', { name: 'inventory', durationMs: 0, slow: false, result: 'unavailable' }])
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

  // A caller that gave up is not a dependency that failed.
  it('ignores a failure that settles after the caller aborted', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'ignored', 'failure')
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const call = runWith(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason))
        }),
      breaker,
      controller.signal,
    )
    controller.abort(reason)

    await expect(call).rejects.toBe(reason)
    expect(breaker.metrics().bufferedCalls).toBe(0)
    expect(seen).toEqual([['ignored', { name: 'inventory', durationMs: 0, error: reason, reason: 'aborted' }]])
  })

  it('forgets failures older than a time window', async () => {
    const breaker = breakerOf({ slidingWindow: { type: 'time', seconds: 10 } })

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
})

describe('circuitBreaker, open', () => {
  it('refuses calls without running them, with an ErrCallNotPermitted that says how long to wait', async () => {
    const breaker = breakerOf()
    await trip(breaker)
    const seen = listen(breaker, 'notPermitted')
    const operation = vi.fn(() => 'ok')
    vi.advanceTimersByTime(400)

    const refused = await runWith(operation, breaker).catch((error: unknown) => error)

    expect(operation).not.toHaveBeenCalled()
    expect(refused).toBeInstanceOf(ErrCallNotPermitted)
    expect(refused).toMatchObject({
      breaker: 'inventory',
      state: 'open',
      retryAfterMs: 600,
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

    const trials = [runWith(() => hung.promise, breaker), runWith(() => hung.promise, breaker)]
    const refused = await succeed(breaker).catch((error: unknown) => error)

    expect(refused).toMatchObject({
      state: 'half_open',
      retryAfterMs: undefined,
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
    const breaker = breakerOf({ waitDurationInOpenStateMs: openCount => openCount * 1_000 })
    const retryAfter = async (): Promise<unknown> =>
      ((await succeed(breaker).catch((error: unknown) => error)) as ErrCallNotPermitted).retryAfterMs

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
    const breaker = breakerOf({ maxWaitDurationInHalfOpenStateMs: 500, permittedNumberOfCallsInHalfOpenState: 1 })
    await halfOpen(breaker)
    const hung = Promise.withResolvers<string>()
    const trial = runWith(() => hung.promise, breaker)

    vi.advanceTimersByTime(500)
    const refused = await succeed(breaker).catch((error: unknown) => error)

    expect(refused).toMatchObject({ state: 'open', retryAfterMs: 1_000 })
    expect(breaker.state).toBe('open')

    hung.resolve('late')
    await trial
    expect(breaker.state).toBe('open')
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

describe('circuitBreaker, late results', () => {
  // The outcome of a call belongs to the state it started in; counting it later would judge the wrong period.
  it('does not record a call that settles after the breaker opened, but still reports it', async () => {
    const breaker = breakerOf()
    const seen = listen(breaker, 'success')
    const slow = Promise.withResolvers<string>()
    const call = runWith(() => slow.promise, breaker)

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
    const call = runWith(() => slow.promise, breaker).catch(() => undefined)

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
      retryAfterMs: undefined,
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

    await expect(runWith(() => 'explode', breaker)).rejects.toThrow('predicate bug')
    expect(breaker.state).toBe('half_open')

    await succeed(breaker)
    expect(breaker.state).toBe('closed')
  })

  it('stays closed and rejects the tripping call when the wait function returns no usable delay', async () => {
    const breaker = breakerOf({ waitDurationInOpenStateMs: () => Number.NaN })

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
  it("starts a captured refusal's stack at CircuitBreaker.run, directly under the caller's entry", async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      const breaker = breakerOf({ captureStackTrace: true })
      breaker.forceOpen()
      const run = compose(breaker)
      function callsTheOpenBreaker(): Promise<string> {
        return run(() => 'ok')
      }

      const refused = (await callsTheOpenBreaker().catch((error: unknown) => error)) as Error
      const frames = refused.stack?.split('\n').slice(1) ?? []
      const caller = frames.findIndex(frame => frame.includes('callsTheOpenBreaker'))

      expect(frames[0]).toContain('CircuitBreaker.run')
      expect(caller).toBeGreaterThan(0)
      expect(caller).toBeLessThanOrEqual(2)
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

  it('hands a refusal back as a rejected promise when run is called directly, never as a throw', async () => {
    const breaker = breakerOf()
    breaker.forceOpen()
    const ctx = { signal: undefined, attempt: 1 } as unknown as ExecutionContext
    let returned: Promise<number> | undefined

    expect(() => {
      returned = breaker.run(ctx, () => Promise.resolve(1))
    }).not.toThrow()
    await expect(returned).rejects.toBeInstanceOf(ErrCallNotPermitted)
  })

  // Without this, a trial whose inner strategy throws before returning a promise would hold its slot forever.
  it('records a trial call whose inner strategy throws synchronously as a failure', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const throwing: Strategy = () => {
      throw new Error('inner strategy bug')
    }

    await expect(runWith(() => 'ok', breaker, throwing)).rejects.toThrow('inner strategy bug')

    expect(breaker.state).toBe('open')
  })

  it('records a trial call whose inner strategy returns a plain value as a success', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const plainValue = (() => 42) as unknown as Strategy

    await expect(runWith(() => 'ok', breaker, plainValue)).resolves.toBe(42)

    expect(breaker.state).toBe('closed')
  })
})

// `run` is public: a strategy that nests a breaker by hand may hand it a `next` the chain never normalised. Whatever
// that `next` does, the call is recorded, its trial slot is settled, and the caller gets a promise.
describe('circuitBreaker, run called by hand', () => {
  const ctx = { signal: undefined, attempt: 1 } as unknown as ExecutionContext

  it('records a trial call as a failure when a hand-made next throws synchronously', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    let result: Promise<unknown> | undefined

    expect(() => {
      result = breaker.run(ctx, () => {
        throw new Error('hand-made next bug')
      })
    }).not.toThrow()
    await expect(result).rejects.toThrow('hand-made next bug')

    expect(breaker.state).toBe('open')
  })

  it('records a trial call as a success when a hand-made next returns a plain value', async () => {
    const breaker = breakerOf({ permittedNumberOfCallsInHalfOpenState: 1 })
    await trip(breaker)
    vi.advanceTimersByTime(1_000)
    const plainValue = (() => 42) as unknown as Next<number>

    await expect(breaker.run(ctx, plainValue)).resolves.toBe(42)

    expect(breaker.state).toBe('closed')
  })

  it('hands a synchronous throw from a hand-made next back as a rejection while disabled', async () => {
    const breaker = breakerOf()
    breaker.disable()
    let result: Promise<unknown> | undefined

    expect(() => {
      result = breaker.run(ctx, () => {
        throw new Error('hand-made next bug')
      })
    }).not.toThrow()
    await expect(result).rejects.toThrow('hand-made next bug')
  })
})
