import { Millisecond } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { circuitBreaker, ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { fakeTimersClock } from '../clock.testkit.js'
import { compose, decorate, run } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import type { Operation } from '../policy.js'
import { ErrTimeLimitExceeded, timeLimiter } from '../timelimiter/timelimiter.js'
import { unhandledRejections } from '../unhandled.testkit.js'
import { fallback, type FallbackEvents, type FallbackHandler, type FallbackOptions } from './fallback.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fallbackOf<R>(handler: FallbackHandler<R>, options: FallbackOptions = {}) {
  return fallback(handler, { name: 'inventory', ...options })
}

function failing(error: unknown): Operation<string> {
  return async () => {
    throw error
  }
}

function listen<K extends keyof FallbackEvents>(
  target: { on: (type: K, listener: (event: FallbackEvents[K]) => unknown) => () => void },
  ...types: K[]
): Array<[K, FallbackEvents[K]]> {
  const seen: Array<[K, FallbackEvents[K]]> = []
  for (const type of types) {
    target.on(type, event => seen.push([type, event]))
  }
  return seen
}

describe('fallback options', () => {
  it('names itself fallback unless told otherwise', () => {
    expect(fallback(() => 'cached').name).toBe('fallback')
    expect(fallbackOf(() => 'cached').name).toBe('inventory')
  })

  it('refuses an empty name', () => {
    expect(() => fallback(() => 'cached', { name: '' })).toThrow(
      'Cannot create fallback: name must be a non-empty string',
    )
  })

  it('refuses a handler that is not a function', () => {
    expect(() => fallbackOf('cached' as never)).toThrow(ErrInvalidOption)
    expect(() => fallbackOf('cached' as never)).toThrow(
      'Cannot create fallback "inventory": handler must be a function, got string',
    )
  })

  it.each([
    ['a boolean', true, 'a boolean'],
    ['a list holding something other than a class', [RangeError, 'TypeError'], 'an object'],
  ])('refuses an on that is %s', (_, on, got) => {
    expect(() => fallbackOf(() => 'cached', { on: on as never })).toThrow(
      `Cannot create fallback "inventory": on must be a function or an array of error classes, got ${got}`,
    )
  })
})

describe('fallback', () => {
  it('passes a value through without running the handler', async () => {
    const handler = vi.fn(() => 'cached')
    const stale = fallbackOf(handler)

    await expect(run(stale.wrap(async () => 'fresh'))).resolves.toBe('fresh')

    expect(handler).not.toHaveBeenCalled()
    expect(stale.metrics()).toEqual({ successfulCalls: 1, recoveredCalls: 0, failedCalls: 0, ignoredCalls: 0 })
  })

  it.each([
    ['a value', (error: unknown) => `cached for ${(error as Error).message}`],
    ['a promise', (error: unknown) => Promise.resolve(`cached for ${(error as Error).message}`)],
  ])('answers a failed call with what the handler returns, as %s', async (_, handler) => {
    const stale = fallbackOf(handler)
    const seen = listen(stale, 'recovered')
    const error = new Error('down')

    await expect(run(stale.wrap(failing(error)))).resolves.toBe('cached for down')

    expect(seen).toEqual([['recovered', { name: 'inventory', error }]])
    expect(stale.metrics()).toEqual({ successfulCalls: 0, recoveredCalls: 1, failedCalls: 0, ignoredCalls: 0 })
  })

  // The answer is usually about the call: the cached stock of the item that was asked for.
  it('hands the handler the arguments of a decorated function', async () => {
    const stale = fallbackOf((_, input) => `cached ${(input as [string])[0]}`)
    const getStock = decorate(stale, async (id: string) => {
      throw new Error(`${id} is down`)
    })

    await expect(getStock('42')).resolves.toBe('cached 42')
  })

  it.each([
    [
      'throws',
      (thrown: Error) => () => {
        throw thrown
      },
    ],
    ['rejects', (thrown: Error) => () => Promise.reject(thrown)],
  ])('rejects with what the handler threw when it %s, reporting both errors', async (_, handlerOf) => {
    const thrown = new Error('cache is down too')
    const stale = fallbackOf(handlerOf(thrown))
    const seen = listen(stale, 'failure')
    const error = new Error('down')

    await expect(run(stale.wrap(failing(error)))).rejects.toBe(thrown)

    expect(seen).toEqual([['failure', { name: 'inventory', error, thrown }]])
    expect(stale.metrics().failedCalls).toBe(1)
  })

  // A fallback that answered every error would hide bugs as well as outages: it answers only what it was told to.
  it.each([
    ['a predicate', (error: unknown) => error instanceof ErrCallRefused],
    ['a list of error classes', [ErrCallRefused]],
  ])('lets an error that on declines, as %s, through unchanged', async (_, on) => {
    const handler = vi.fn(() => 'cached')
    const stale = fallbackOf(handler, { on })
    const seen = listen(stale, 'ignored')
    const bug = new TypeError('undefined is not a function')

    await expect(run(stale.wrap(failing(bug)))).rejects.toBe(bug)

    expect(handler).not.toHaveBeenCalled()
    expect(seen).toEqual([['ignored', { name: 'inventory', error: bug, reason: 'not_handled' }]])
    expect(stale.metrics().ignoredCalls).toBe(1)
  })

  it('answers an error that is an instance of a class on lists, subclasses included', async () => {
    const stale = fallbackOf(() => 'cached', { on: [ErrCallRefused] })

    await expect(run(stale.wrap(failing(new ErrCallNotPermitted('inventory', 'open', 0))))).resolves.toBe('cached')
  })

  // Nobody is waiting for the value: computing it would only cost the dependency a cache read.
  it('never runs once the caller’s signal has aborted', async () => {
    const handler = vi.fn(() => 'cached')
    const stale = fallbackOf(handler)
    const seen = listen(stale, 'ignored')
    const caller = new AbortController()
    const reason = new Error('caller gave up')

    const call = run(
      stale.wrap(async () => {
        caller.abort(reason)
        throw reason
      }),
      caller.signal,
    )

    await expect(call).rejects.toBe(reason)
    expect(handler).not.toHaveBeenCalled()
    expect(seen).toEqual([['ignored', { name: 'inventory', error: reason, reason: 'aborted' }]])
  })

  it.each([
    ['a promise', Promise.resolve(true)],
    ['undefined', undefined],
    ['a string', 'yes'],
  ])('rejects with ErrInvalidOption when on returns %s', async (got, verdict) => {
    const handler = vi.fn(() => 'cached')
    const stale = fallbackOf(handler, { on: (() => verdict) as never })

    const error = await run(stale.wrap(failing(new Error('down')))).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain(`Cannot run fallback "inventory": on must return a boolean, got ${got}`)
    expect(handler).not.toHaveBeenCalled()
    expect(stale.metrics().failedCalls).toBe(1)
  })

  it('counts each call once, by how it ended', async () => {
    let answer: () => string = () => 'cached'
    const stale = fallbackOf(() => answer(), { on: error => (error as Error).message !== 'bug' })
    const caller = new AbortController()

    await run(stale.wrap(async () => 'ok'))
    await run(stale.wrap(failing(new Error('down'))))
    await run(stale.wrap(failing(new Error('bug')))).catch(() => undefined)
    answer = () => {
      throw new Error('again')
    }
    await run(stale.wrap(failing(new Error('down')))).catch(() => undefined)
    await run(
      stale.wrap(async () => {
        caller.abort()
        throw new Error('down')
      }),
      caller.signal,
    ).catch(() => undefined)

    expect(stale.metrics()).toEqual({ successfulCalls: 1, recoveredCalls: 1, failedCalls: 1, ignoredCalls: 2 })
  })
})

describe('fallback, unhandled rejections', () => {
  // Every way a call can end must settle the caller's promise and leave no other one rejected behind it.
  it('leaves no rejection unhandled, whichever way a call ends', async () => {
    const reasons = await unhandledRejections(async () => {
      const caller = new AbortController()
      const calls = [
        run(
          fallbackOf(() => {
            throw new Error('cache bug')
          }).wrap(failing(new Error('down'))),
        ),
        run(fallbackOf(() => Promise.reject(new Error('cache down'))).wrap(failing(new Error('down')))),
        run(fallbackOf(() => 'cached', { on: [RangeError] }).wrap(failing(new Error('down')))),
        run(fallbackOf(() => 'cached', { on: (() => 'yes') as never }).wrap(failing(new Error('down')))),
        run(
          fallbackOf(() => 'cached').wrap(async () => {
            caller.abort()
            throw new Error('down')
          }),
          caller.signal,
        ),
      ].map(call => call.catch(() => undefined))
      await Promise.all(calls)
    })

    expect(reasons).toEqual([])
  })
})

describe('fallback around a chain', () => {
  it('answers an open circuit breaker’s refusal with the call’s own data', async () => {
    const breaker = circuitBreaker({ name: 'inventory', clock: fakeTimersClock })
    breaker.forceOpen()
    const operation = vi.fn(async (id: string) => `fresh ${id}`)
    const getStock = decorate(
      compose(
        fallbackOf((_, input) => `cached ${(input as [string])[0]}`, { on: [ErrCallRefused] }),
        breaker,
      ),
      operation,
    )

    await expect(getStock('42')).resolves.toBe('cached 42')
    expect(operation).not.toHaveBeenCalled()
  })

  // A timeout leaves the outcome unknown: the call may have gone through. A fallback limited to refusals answers only
  // calls that certainly never ran.
  it('leaves a timeout alone when it only answers refusals', async () => {
    const inventory = compose(
      fallbackOf(() => 'cached', { on: [ErrCallRefused] }),
      timeLimiter({ name: 'inventory', timeoutDuration: 100 * Millisecond, clock: fakeTimersClock }),
    )

    const call = run(inventory(() => new Promise<string>(() => undefined))).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)

    expect(await call).toBeInstanceOf(ErrTimeLimitExceeded)
  })

  it('answers a refusal from a breaker that opened on the calls before', async () => {
    const breaker = circuitBreaker({
      name: 'inventory',
      minimumNumberOfCalls: 2,
      slidingWindow: { type: 'count', size: 2 },
      clock: fakeTimersClock,
    })
    const guarded = breaker.wrap(failing(new Error('down')))
    const answered = compose(
      fallbackOf(() => 'cached', { on: [ErrCallRefused] }),
      breaker,
    )(failing(new Error('down')))

    await run(guarded).catch(() => undefined)
    await run(guarded).catch(() => undefined)
    const refusal = await run(guarded).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ErrCallNotPermitted)
    await expect(run(answered)).resolves.toBe('cached')
  })
})
