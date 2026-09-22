import { describe, expect, it } from 'vitest'

import { composeObservers, type CacheHitEvent, type CacheObserver, type CacheRoute } from '../observer.js'

const route: CacheRoute = Object.freeze({ method: 'GET', url: '/pets/:id' })
const hit: CacheHitEvent = { route, key: '%2Fpets%2F1', revalidated: false, ageSeconds: 3, coalesced: false }

describe('composeObservers', () => {
  it('hands every event to each observer, in argument order', () => {
    const calls: string[] = []
    const first: CacheObserver = { onHit: e => calls.push(`first:${e.key}`) }
    const second: CacheObserver = { onHit: e => calls.push(`second:${e.key}`) }

    composeObservers(first, second).onHit!(hit)

    expect(calls).toEqual(['first:%2Fpets%2F1', 'second:%2Fpets%2F1'])
  })

  // The cache hooks call `observer.onMiss?.(...)` and skip building the event when the method is absent. A composed
  // observer that always defined every method would make every hook build every event for nobody.
  it('defines only the methods some member implements', () => {
    const composed = composeObservers({}, { onHit: () => {} })

    expect(composed.onHit).toBeTypeOf('function')
    expect(composed.onMiss).toBeUndefined()
    expect(composed.onBypass).toBeUndefined()
    expect(composed.onStore).toBeUndefined()
    expect(composed.onInvalidate).toBeUndefined()
    expect(composeObservers()).toEqual({})
  })

  it('calls each member as a method, so a class-based observer keeps its own state', () => {
    class Counting implements CacheObserver {
      #hits = 0

      get hits(): number {
        return this.#hits
      }

      onHit(): void {
        this.#hits++
      }
    }

    const counting = new Counting()
    composeObservers(counting).onHit!(hit)

    expect(counting.hits).toBe(1)
  })

  // One policy for a throwing observer, applied where the cache calls it: composing adds no second layer.
  it('lets a throw escape, and the members after it are not called', () => {
    const calls: string[] = []
    const composed = composeObservers(
      {
        onHit: () => {
          throw new Error('boom')
        },
      },
      { onHit: () => calls.push('after') },
    )

    expect(() => composed.onHit!(hit)).toThrow('boom')
    expect(calls).toEqual([])
  })
})
