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

  // A caller can give up from inside the call itself, as a backend that aborts on a broken connection does. The
  // lease it still returns must reach someone who can give it back, or the key stays taken for a whole lease.
  it('hands the answer of a call the caller abandoned during the call itself to onLate', async () => {
    const controller = new AbortController()
    const reason = new Error('caller went away')
    const late: string[] = []

    const bounded = boundedCall(
      { ...call, signal: controller.signal },
      () => {
        controller.abort(reason)
        return Promise.resolve('lease')
      },
      value => late.push(value),
    )

    await expect(bounded).rejects.toBe(reason)
    await Promise.resolve()
    expect(late).toEqual(['lease'])
  })

  // With nobody to tell, a late failure is dropped: an unhandled rejection would crash a process run with the
  // default `--unhandled-rejections=throw`.
  // A backend that blocks the event loop past the deadline answers before the timer gets to fire. The answer is
  // late all the same: a lease in it must go to onLate, not to a caller who would hold it past its deadline.
  it('treats an answer that arrives past the deadline as late while the timer has yet to fire', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const late: string[] = []

    const bounded = boundedCall(
      { ...call, timeout: 10 },
      () => {
        vi.advanceTimersByTime(20)
        return Promise.resolve('lease')
      },
      value => late.push(value),
    ).catch((e: unknown) => e)

    expect(await bounded).toBeInstanceOf(ErrLockBackendTimeout)
    expect(late).toEqual(['lease'])
  })

  it('drops a late rejection when no onLateError is given, without an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { promise, reject } = Promise.withResolvers<string>()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)

    try {
      const bounded = boundedCall(call, () => promise).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(5 * Second)
      expect(await bounded).toBeInstanceOf(ErrLockBackendTimeout)

      reject(new Error('boom'))
      await vi.advanceTimersByTimeAsync(0)
      await new Promise(resolve => setImmediate(resolve))

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
