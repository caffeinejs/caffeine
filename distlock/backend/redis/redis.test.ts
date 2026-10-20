import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RedisLockBackend, type RedisLockClient } from './index.js'

// Answers as a server would, and records what it was sent.
function stubClient({ set = 'OK', eval: evaluated = 1 }: { set?: unknown; eval?: unknown } = {}) {
  return {
    set: vi.fn<RedisLockClient['set']>(() => Promise.resolve(set)),
    eval: vi.fn<RedisLockClient['eval']>(() => Promise.resolve(evaluated)),
  }
}

const TTL = 1 * Second + 0.5 * Millisecond

describe('RedisLockBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // `PX` takes whole milliseconds. Rounded up, the key never expires before the lease says it does.
  it('writes the key only when absent, for the ttl in whole milliseconds rounded up', async () => {
    const client = stubClient()
    const start = Date.now()

    const lease = await new RedisLockBackend(client).tryAcquire('k', TTL)

    const [key, token, options] = client.set.mock.calls[0]
    expect(key).toBe('k')
    expect(options).toEqual({ expiration: { type: 'PX', value: 1001 }, condition: 'NX' })
    expect(lease).toEqual({ key: 'k', token, expiresAt: start + 1001 })
  })

  it('hands out no lease when the key is held', async () => {
    const client = stubClient({ set: null })

    expect(await new RedisLockBackend(client).tryAcquire('k', TTL)).toBeUndefined()
  })

  it('asks nothing of the server once the signal has aborted', async () => {
    const client = stubClient()

    await expect(new RedisLockBackend(client).tryAcquire('k', TTL, AbortSignal.abort())).rejects.toThrow()
    expect(client.set).not.toHaveBeenCalled()
  })

  it('extends a lease it still holds, for the ttl in whole milliseconds rounded up', async () => {
    const client = stubClient()
    const start = Date.now()
    const lease = { key: 'k', token: 't', expiresAt: start }

    const extended = await new RedisLockBackend(client).extend(lease, TTL)

    expect(client.eval.mock.calls[0][1]).toEqual({ keys: ['k'], arguments: ['t', '1001'] })
    expect(extended).toEqual({ key: 'k', token: 't', expiresAt: start + 1001 })
  })

  it('extends nothing once another holder has the key', async () => {
    const client = stubClient({ eval: 0 })

    expect(await new RedisLockBackend(client).extend({ key: 'k', token: 't', expiresAt: 0 }, TTL)).toBeUndefined()
  })
})
