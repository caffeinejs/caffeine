import { Millisecond } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { circuitBreaker, ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { compose } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { ErrTimeLimitExceeded, timeLimiter } from '../timelimiter/timelimiter.js'
import { fallback, type FallbackEvents, type FallbackOptions } from './fallback.js'

beforeEach(() => {
  useFakeClock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fallbackOf(options: Partial<FallbackOptions> = {}) {
  return fallback({ name: 'inventory', ...options })
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
  it('requires a name', () => {
    expect(() => fallback({ name: '' })).toThrow('Cannot create fallback: name must be a non-empty string')
  })

  it('refuses a fallbackOn that is not a function', () => {
    expect(() => fallbackOf({ fallbackOn: true as never })).toThrow(
      'Cannot create fallback "inventory": fallbackOn must be a function, got boolean',
    )
  })

  it('exposes its name', () => {
    expect(fallbackOf().name).toBe('inventory')
  })
})

describe('fallback', () => {
  it('passes a value through without running the handler', async () => {
    const stale = fallbackOf()
    const handler = vi.fn(() => 'cached')

    await expect(stale.recover(Promise.resolve('fresh'), handler)).resolves.toBe('fresh')

    expect(handler).not.toHaveBeenCalled()
    expect(stale.metrics()).toEqual({ successfulCalls: 1, recoveredCalls: 0, failedCalls: 0, ignoredCalls: 0 })
  })

  it.each([
    ['a value', (error: unknown) => `cached for ${(error as Error).message}`],
    ['a promise', (error: unknown) => Promise.resolve(`cached for ${(error as Error).message}`)],
  ])('answers a failed call with what the handler returns, as %s', async (_, handler) => {
    const stale = fallbackOf()
    const seen = listen(stale, 'recovered')
    const error = new Error('down')

    await expect(stale.recover(Promise.reject(error), handler)).resolves.toBe('cached for down')

    expect(seen).toEqual([['recovered', { name: 'inventory', error }]])
    expect(stale.metrics()).toEqual({ successfulCalls: 0, recoveredCalls: 1, failedCalls: 0, ignoredCalls: 0 })
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
    const stale = fallbackOf()
    const seen = listen(stale, 'failure')
    const error = new Error('down')
    const thrown = new Error('cache is down too')

    await expect(stale.recover(Promise.reject(error), handlerOf(thrown))).rejects.toBe(thrown)

    expect(seen).toEqual([['failure', { name: 'inventory', error, thrown }]])
    expect(stale.metrics().failedCalls).toBe(1)
  })

  // A fallback that answered every error would hide bugs as well as outages: it answers only what it was told to.
  it('lets an error fallbackOn declines through unchanged', async () => {
    const stale = fallbackOf({ fallbackOn: error => error instanceof ErrCallRefused })
    const seen = listen(stale, 'ignored')
    const handler = vi.fn(() => 'cached')
    const bug = new TypeError('undefined is not a function')

    await expect(stale.recover(Promise.reject(bug), handler)).rejects.toBe(bug)

    expect(handler).not.toHaveBeenCalled()
    expect(seen).toEqual([['ignored', { name: 'inventory', error: bug, reason: 'not_handled' }]])
    expect(stale.metrics().ignoredCalls).toBe(1)
  })

  // Nobody is waiting for the value: computing it would only cost the dependency a cache read.
  it('never runs once the caller’s signal has aborted', async () => {
    const stale = fallbackOf()
    const seen = listen(stale, 'ignored')
    const handler = vi.fn(() => 'cached')
    const caller = new AbortController()
    const reason = new Error('caller gave up')
    caller.abort(reason)

    await expect(stale.recover(Promise.reject(reason), handler, caller.signal)).rejects.toBe(reason)

    expect(handler).not.toHaveBeenCalled()
    expect(seen).toEqual([['ignored', { name: 'inventory', error: reason, reason: 'aborted' }]])
  })

  it.each([
    ['a promise', Promise.resolve(true)],
    ['undefined', undefined],
    ['a string', 'yes'],
  ])('rejects with ErrInvalidOption when fallbackOn returns %s', async (got, verdict) => {
    const stale = fallbackOf({ fallbackOn: (() => verdict) as never })
    const handler = vi.fn(() => 'cached')

    const error = await stale.recover(Promise.reject(new Error('down')), handler).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain(
      `Cannot run fallback "inventory": fallbackOn must return a boolean, got ${got}`,
    )
    expect(handler).not.toHaveBeenCalled()
    expect(stale.metrics().failedCalls).toBe(1)
  })

  it('rejects with ErrInvalidOption when handed a handler that is not a function', async () => {
    const stale = fallbackOf()

    await expect(stale.recover(Promise.reject(new Error('down')), 'cached' as never)).rejects.toThrow(
      'Cannot recover with fallback "inventory": the handler must be a function, got string',
    )
  })

  it('counts each call once, by how it ended', async () => {
    const stale = fallbackOf({ fallbackOn: error => (error as Error).message !== 'bug' })
    const caller = new AbortController()

    await stale.recover(Promise.resolve('ok'), () => 'cached')
    await stale.recover(Promise.reject(new Error('down')), () => 'cached')
    await stale.recover(Promise.reject(new Error('bug')), () => 'cached').catch(() => undefined)
    await stale
      .recover(Promise.reject(new Error('down')), () => {
        throw new Error('again')
      })
      .catch(() => undefined)
    caller.abort()
    await stale.recover(Promise.reject(new Error('down')), () => 'cached', caller.signal).catch(() => undefined)

    expect(stale.metrics()).toEqual({ successfulCalls: 1, recoveredCalls: 1, failedCalls: 1, ignoredCalls: 2 })
  })
})

describe('fallback around a chain', () => {
  it('answers an open circuit breaker’s refusal with the call’s own data', async () => {
    const breaker = circuitBreaker({ name: 'inventory' })
    breaker.forceOpen()
    const inventory = compose(breaker)
    const stale = fallbackOf({ fallbackOn: error => error instanceof ErrCallRefused })
    const operation = vi.fn(() => 'fresh')
    const getStock = (id: string) => stale.recover(inventory(operation), () => `cached ${id}`)

    await expect(getStock('42')).resolves.toBe('cached 42')
    expect(operation).not.toHaveBeenCalled()
  })

  // A timeout leaves the outcome unknown: the call may have gone through. A fallback limited to refusals answers only
  // calls that certainly never ran.
  it('leaves a timeout alone when it only answers refusals', async () => {
    const inventory = compose(timeLimiter({ name: 'inventory', timeoutDuration: 100 * Millisecond }))
    const stale = fallbackOf({ fallbackOn: error => error instanceof ErrCallRefused })

    const call = stale
      .recover(
        inventory(() => new Promise(() => undefined)),
        () => 'cached',
      )
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)

    expect(await call).toBeInstanceOf(ErrTimeLimitExceeded)
  })

  it('answers a refusal from a breaker that opened on the calls before', async () => {
    const breaker = circuitBreaker({
      name: 'inventory',
      minimumNumberOfCalls: 2,
      slidingWindow: { type: 'count', size: 2 },
    })
    const inventory = compose(breaker)
    const stale = fallbackOf({ fallbackOn: error => error instanceof ErrCallRefused })
    const failing = () => {
      throw new Error('down')
    }

    await inventory(failing).catch(() => undefined)
    await inventory(failing).catch(() => undefined)
    const refusal = await inventory(failing).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ErrCallNotPermitted)
    await expect(stale.recover(inventory(failing), () => 'cached')).resolves.toBe('cached')
  })
})
