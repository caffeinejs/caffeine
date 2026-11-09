import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrLockBackendTimeout } from './errors.js'
import { boundedCall, type StoreCall } from './store_call.js'

const call: StoreCall = { operation: 'acquire', key: 'orders:rebuild', timeout: 5 * Second, bound: 'storeTimeout' }

afterEach(() => {
  vi.useRealTimers()
})

describe('boundedCall', () => {
  // The value a backend hands over late is a lease nobody waits for: it must reach someone who can give it back.
  it('rejects with ErrLockBackendTimeout when the call does not settle in time, and hands the late value to onLate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { promise, resolve } = Promise.withResolvers<string>()
    const late: string[] = []

    const bounded = boundedCall(
      call,
      () => promise,
      value => late.push(value),
    ).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)

    const error = await bounded
    expect(error).toBeInstanceOf(ErrLockBackendTimeout)
    expect((error as ErrLockBackendTimeout).code).toBe('ERR_LOCK_BACKEND_TIMEOUT')
    expect((error as ErrLockBackendTimeout).timeout).toBe(5 * Second)
    expect(late).toEqual([])

    resolve('lease')
    await vi.advanceTimersByTimeAsync(0)

    expect(late).toEqual(['lease'])
  })

  it("rejects with the caller's reason when the signal aborts first, and not with a timeout", async () => {
    const controller = new AbortController()
    const reason = new Error('caller went away')
    const seen: AbortSignal[] = []

    const bounded = boundedCall({ ...call, signal: controller.signal }, signal => {
      seen.push(signal)
      return new Promise<string>(() => undefined)
    })
    controller.abort(reason)

    await expect(bounded).rejects.toBe(reason)
    expect(seen[0]!.reason).toBe(reason)
  })

  it("settles with the call's own result when it answers in time, and leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const late: string[] = []

    await expect(
      boundedCall(
        call,
        () => Promise.resolve('lease'),
        value => late.push(value),
      ),
    ).resolves.toBe('lease')

    expect(vi.getTimerCount()).toBe(0)
    expect(late).toEqual([])
  })

  it('rejects at once without calling the backend when the signal is already aborted', async () => {
    const reason = new Error('caller went away')
    let calls = 0

    const bounded = boundedCall({ ...call, signal: AbortSignal.abort(reason) }, () => {
      calls += 1
      return Promise.resolve('lease')
    })

    await expect(bounded).rejects.toBe(reason)
    expect(calls).toBe(0)
  })

  // A late failure has nobody waiting for it; it must not surface as an unhandled rejection.
  it('hands a late rejection to onLateError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { promise, reject } = Promise.withResolvers<string>()
    const errors: unknown[] = []
    const boom = new Error('boom')

    const bounded = boundedCall(
      call,
      () => promise,
      undefined,
      error => errors.push(error),
    ).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await bounded

    reject(boom)
    await vi.advanceTimersByTimeAsync(0)

    expect(errors).toEqual([boom])
  })
})
