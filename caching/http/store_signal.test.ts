import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it, vi } from 'vitest'

import { ErrCacheStoreTimeout, withStoreSignal } from './store_signal.js'

describe('withStoreSignal', () => {
  // With a default timeout every store call has a timer: one that outlived its call would be one per call, alive
  // for the whole timeout.
  it('clears its timer when the call settles first', async () => {
    vi.useFakeTimers()
    try {
      await expect(withStoreSignal('get', undefined, 1000, () => Promise.resolve('entry'))).resolves.toBe('entry')
      expect(vi.getTimerCount()).toBe(0)

      await expect(withStoreSignal('put', undefined, 1000, () => Promise.reject(new Error('down')))).rejects.toThrow(
        'down',
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('calls nothing for a request already over, and rejects with its reason', async () => {
    const request = new AbortController()
    request.abort(new Error('client gone'))
    const call = vi.fn(() => Promise.resolve('entry'))

    await expect(withStoreSignal('get', request.signal, 1000, call)).rejects.toThrow('client gone')
    expect(call).not.toHaveBeenCalled()
  })

  // Without a timeout a call is bounded by the request alone: it ends when the request does, and the cache arms
  // nothing of its own to bound it.
  it('bounds a call by the request alone, with no timer, when no timeout is set', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const request = new AbortController()
      const pending = withStoreSignal(
        'get',
        request.signal,
        undefined,
        signal =>
          new Promise<never>((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
          }),
      )
      expect(vi.getTimerCount()).toBe(0)

      request.abort(new Error('client gone'))

      await expect(pending).rejects.toThrow('client gone')
    } finally {
      vi.useRealTimers()
    }
  })

  // The store is handed one signal, aborted by the timeout, and the store's own abort rejection, which it sends
  // second, must neither be the one reported nor go unhandled.
  it('aborts the signal it handed over on timeout, and reports the timeout whatever the store rejects with', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    let handed: AbortSignal | undefined

    try {
      const call = (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          handed = signal
          signal!.addEventListener('abort', () => reject(new Error('the store noticed the abort')), { once: true })
        })

      await expect(withStoreSignal('put', undefined, 5, call)).rejects.toBeInstanceOf(ErrCacheStoreTimeout)
      expect(handed?.aborted).toBe(true)
      await sleep(20)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  })

  it('composes the request signal with the timeout, and rejects with the request reason when that aborts first', async () => {
    const request = new AbortController()
    let handed: AbortSignal | undefined
    const pending = withStoreSignal('get', request.signal, 1000, signal => {
      handed = signal
      return new Promise<never>(() => {})
    })

    request.abort(new Error('client gone'))

    await expect(pending).rejects.toThrow('client gone')
    expect(handed?.aborted).toBe(true)
  })

  it('leaves no rejection unhandled when the store rejects after the timeout', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      const late = () =>
        sleep(30).then(() => {
          throw new Error('late')
        })

      await expect(withStoreSignal('put', undefined, 5, late)).rejects.toBeInstanceOf(ErrCacheStoreTimeout)
      await sleep(50)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  })
})
