import type { AdapterRouteOptions } from '@caffeinejs/http'
import type { Logger } from '@caffeinejs/std/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cacheRouteOf, guardObserver, storeErrorLogger } from './_observe.js'
import type { CacheBypassEvent, CacheErrorEvent, CacheObserver } from './observer.js'

function routeDef(
  method: string | string[],
  caffeine?: { group: string; route: string | symbol },
): AdapterRouteOptions {
  return {
    method,
    url: '/api/pets/:id',
    handler: () => {},
    config: caffeine && { $caffeine: { group: { name: caffeine.group }, route: { name: caffeine.route } } },
  } as unknown as AdapterRouteOptions
}

describe('cacheRouteOf', () => {
  it('joins the methods of a framework route and keeps the single method of a HEAD twin', () => {
    expect(cacheRouteOf(routeDef(['GET', 'POST'])).method).toBe('GET|POST')
    expect(cacheRouteOf(routeDef('HEAD')).method).toBe('HEAD')
  })

  it('reports the registered pattern, not a request URL', () => {
    expect(cacheRouteOf(routeDef(['GET'])).url).toBe('/api/pets/:id')
  })

  it('names the handler after its group and route when the framework compiled the route', () => {
    expect(cacheRouteOf(routeDef(['GET'], { group: 'PetsController', route: 'find' })).handler).toBe(
      'PetsController.find',
    )
  })

  // A route straight on Fastify carries no `$caffeine`; a programmatic route may be unnamed; a symbol-named
  // method would stringify to `Symbol(...)`. None of those is a name worth a metric attribute.
  it('leaves the handler out when there is no usable name', () => {
    expect(cacheRouteOf(routeDef(['GET']))).not.toHaveProperty('handler')
    expect(cacheRouteOf(routeDef(['GET'], { group: 'PetsController', route: '' }))).not.toHaveProperty('handler')
    expect(cacheRouteOf(routeDef(['GET'], { group: '', route: 'find' }))).not.toHaveProperty('handler')
    expect(cacheRouteOf(routeDef(['GET'], { group: 'PetsController', route: Symbol('find') }))).not.toHaveProperty(
      'handler',
    )
  })

  // Every observer receives this same object on every request to the route; one observer mutating it would
  // corrupt what all the others see.
  it('is frozen', () => {
    expect(Object.isFrozen(cacheRouteOf(routeDef(['GET'])))).toBe(true)
  })
})

describe('guardObserver', () => {
  const bypass: CacheBypassEvent = { route: Object.freeze({ method: 'GET', url: '/pets' }), reason: 'method' }

  function recordingLog() {
    const errors: unknown[][] = []
    const log = { error: (...args: unknown[]) => errors.push(args) } as unknown as Logger
    return { log, errors }
  }

  function throwing(): CacheObserver {
    return {
      onBypass() {
        throw new Error('boom')
      },
      onMiss() {
        throw new Error('bang')
      },
    }
  }

  it('keeps a throw from escaping', () => {
    const { log } = recordingLog()

    expect(() => guardObserver(throwing(), log).onBypass!(bypass)).not.toThrow()
  })

  // A broken observer on a hot route would otherwise write one error line per request.
  it('logs the first throw from a method and drops the ones after it', () => {
    const { log, errors } = recordingLog()
    const guarded = guardObserver(throwing(), log)

    guarded.onBypass!(bypass)
    guarded.onBypass!(bypass)
    guarded.onBypass!(bypass)

    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toMatchObject({ err: expect.objectContaining({ message: 'boom' }) })
    expect(errors[0][1]).toBe('Cache observer "onBypass" threw; further throws from "onBypass" are suppressed')
  })

  it('reports each method on its own', () => {
    const { log, errors } = recordingLog()
    const guarded = guardObserver(throwing(), log)

    guarded.onBypass!(bypass)
    guarded.onMiss!({ ...bypass, key: 'k', reason: 'absent' })

    expect(errors.map(args => args[1])).toEqual([
      'Cache observer "onBypass" threw; further throws from "onBypass" are suppressed',
      'Cache observer "onMiss" threw; further throws from "onMiss" are suppressed',
    ])
  })

  // One process runs many applications — every test file does. Suppression shared between them would hide the
  // second application's broken observer entirely.
  it('does not share suppression between two guards', () => {
    const { log, errors } = recordingLog()
    const observer = throwing()

    guardObserver(observer, log).onBypass!(bypass)
    guardObserver(observer, log).onBypass!(bypass)

    expect(errors).toHaveLength(2)
  })

  // `async onBypass()` fits the `void` signature. Its rejection has no handler of its own, and an unhandled
  // rejection ends the process.
  it('handles a rejection from an async method like a throw, once', async () => {
    const { log, errors } = recordingLog()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      const guarded = guardObserver(
        {
          async onBypass() {
            throw new Error('late boom')
          },
        },
        log,
      )

      guarded.onBypass!(bypass)
      guarded.onBypass!(bypass)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toMatchObject({ err: expect.objectContaining({ message: 'late boom' }) })
  })

  it('defines only the methods the observer implements, and calls them as methods', () => {
    const { log } = recordingLog()

    class Counting implements CacheObserver {
      #bypasses = 0

      get bypasses(): number {
        return this.#bypasses
      }

      onBypass(): void {
        this.#bypasses++
      }
    }

    const counting = new Counting()
    const guarded = guardObserver(counting, log)
    guarded.onBypass!(bypass)

    expect(counting.bypasses).toBe(1)
    expect(guarded.onHit).toBeUndefined()
  })
})

// A store that is down fails every request on every cached route. The outage has to be reported, and the
// report must not arrive at request rate.
describe('storeErrorLogger', () => {
  const route = Object.freeze({ method: 'GET', url: '/pets' })
  const failed = (operation: CacheErrorEvent['operation']): CacheErrorEvent => ({
    route,
    operation,
    error: new Error('store down'),
  })

  function recordingLog() {
    const errors: unknown[][] = []
    const log = { error: (...args: unknown[]) => errors.push(args) } as unknown as Logger
    return { log, errors }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs the first failure, stays quiet for a minute, then logs again', () => {
    vi.useFakeTimers()
    const { log, errors } = recordingLog()
    const observer = storeErrorLogger(log)

    observer.onError!(failed('get'))
    vi.advanceTimersByTime(59_000)
    observer.onError!(failed('get'))
    expect(errors).toHaveLength(1)

    vi.advanceTimersByTime(2_000)
    observer.onError!(failed('get'))
    expect(errors).toHaveLength(2)
  })

  it('counts each operation on its own', () => {
    vi.useFakeTimers()
    const { log, errors } = recordingLog()
    const observer = storeErrorLogger(log)

    observer.onError!(failed('get'))
    observer.onError!(failed('put'))

    expect(errors).toHaveLength(2)
    expect((errors[0][0] as { operation: string; err: Error }).operation).toBe('get')
    expect((errors[0][0] as { err: Error }).err.message).toBe('store down')
  })

  // Zero cost when unobserved: a method that exists makes the hooks build an event for it on every request.
  it('listens for failures and nothing else', () => {
    expect(Object.keys(storeErrorLogger(recordingLog().log))).toEqual(['onError'])
  })
})
