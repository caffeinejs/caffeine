import { getEventListeners } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sleep } from './_sleep.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    let done = false
    const slept = sleep(100, undefined).then(() => (done = true))

    await vi.advanceTimersByTimeAsync(99)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await slept

    expect(done).toBe(true)
  })

  it('schedules no timer for a zero delay', async () => {
    const slept = sleep(0, undefined)

    expect(vi.getTimerCount()).toBe(0)
    await slept
  })

  // Many calls sleeping on one long-lived signal would otherwise pile listeners onto it.
  it('removes its abort listener when it wakes', async () => {
    const controller = new AbortController()
    const slept = sleep(100, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)
    await slept

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('rejects with the abort reason at once, leaving no timer and no listener', async () => {
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    const slept = sleep(60_000, controller.signal)

    controller.abort(reason)

    await expect(slept).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('rejects without scheduling anything when the signal is already aborted', async () => {
    const reason = new Error('caller gave up')

    await expect(sleep(100, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })
})
