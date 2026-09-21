import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { ErrCacheStoreTimeout, withStoreTimeout } from './store_timeout.js'

describe('withStoreTimeout', () => {
  // The unbounded path is the default one, and it runs on every request of a cached route.
  it('hands the call back untouched when no timeout is set', () => {
    const call = Promise.resolve('entry')

    expect(withStoreTimeout(call, 'get', undefined)).toBe(call)
  })

  it('settles as the call does when the call is first', async () => {
    await expect(withStoreTimeout(Promise.resolve('entry'), 'get', 1000)).resolves.toBe('entry')
    await expect(withStoreTimeout(Promise.reject(new Error('down')), 'get', 1000)).rejects.toThrow('down')
  })

  // The store call is abandoned, not cancelled: it may still reject, long after anyone is waiting for it.
  it('leaves no rejection unhandled when the store rejects after the timeout', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      const late = sleep(30).then(() => {
        throw new Error('late')
      })

      await expect(withStoreTimeout(late, 'put', 5)).rejects.toBeInstanceOf(ErrCacheStoreTimeout)
      await sleep(50)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
  })
})
