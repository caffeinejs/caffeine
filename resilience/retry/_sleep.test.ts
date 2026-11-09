import { getEventListeners } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeTimersClock } from '../clock.testkit.js'
import { sleep } from './_sleep.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// Records how a sleep ended.
function sleeper() {
  const ended: unknown[] = []
  return {
    ended,
    wake: () => ended.push('woke'),
    abort: (reason: unknown) => ended.push(reason),
  }
}

describe('sleep', () => {
  it('wakes after the delay', async () => {
    const s = sleeper()
    sleep(100, undefined, fakeTimersClock, s.wake, s.abort)

    await vi.advanceTimersByTimeAsync(99)
    expect(s.ended).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(s.ended).toEqual(['woke'])
  })

  // The retry adds the call to its waiting calls after starting the sleep: a wake before then would leave it there.
  it('wakes after it returns, without a timer, for a zero delay', async () => {
    const s = sleeper()

    sleep(0, undefined, fakeTimersClock, s.wake, s.abort)

    expect(s.ended).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await Promise.resolve()
    expect(s.ended).toEqual(['woke'])
  })

  // Many calls sleeping on one long-lived signal would otherwise pile listeners onto it.
  it('removes its abort listener when it wakes', async () => {
    const controller = new AbortController()
    const s = sleeper()
    sleep(100, controller.signal, fakeTimersClock, s.wake, s.abort)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)

    expect(s.ended).toEqual(['woke'])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('aborts with the abort reason at once, leaving no timer and no listener', () => {
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    const s = sleeper()
    sleep(60_000, controller.signal, fakeTimersClock, s.wake, s.abort)

    controller.abort(reason)

    expect(s.ended).toEqual([reason])
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('aborts after it returns, without scheduling anything, when the signal is already aborted', async () => {
    const reason = new Error('caller gave up')
    const s = sleeper()

    sleep(100, AbortSignal.abort(reason), fakeTimersClock, s.wake, s.abort)

    expect(s.ended).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await Promise.resolve()
    expect(s.ended).toEqual([reason])
  })

  // Disposing a retry ends its waiting calls itself: the sleep must neither wake them later nor hold the process.
  it.each([
    ['a timer', 100],
    ['no timer', 0],
  ])('ends without waking or aborting when cancelled, with %s', async (_, ms) => {
    const controller = new AbortController()
    const s = sleeper()
    const cancel = sleep(ms, controller.signal, fakeTimersClock, s.wake, s.abort)

    cancel()
    controller.abort(new Error('caller gave up'))
    await vi.advanceTimersByTimeAsync(100)

    expect(s.ended).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
