import { Day, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RedisLockBackend, type RedisLockClient } from './index.js'

// Answers every script as a server would, and records what it was sent.
function stubClient(reply: unknown = 1) {
  return { eval: vi.fn<RedisLockClient['eval']>(() => Promise.resolve(reply)) }
}

const TTL = 1 * Second + 0.5 * Millisecond

describe('RedisLockBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // `PX` takes whole milliseconds. Rounded up, the key never expires before the lease says it does. The fence key
  // shares the lock key's hash tag, so one script can touch both on a cluster.
  it('takes the key and numbers the lease in one script, with the fence key in the lock key slot', async () => {
    const client = stubClient('1700000000000001')
    const start = Date.now()

    const lease = await new RedisLockBackend(client).tryAcquire('k', TTL)

    expect(client.eval).toHaveBeenCalledTimes(1)
    const { keys, arguments: args } = client.eval.mock.calls[0][1]
    expect(keys).toEqual(['k', '{k}:fence'])
    expect(args.slice(1)).toEqual(['1001', String(1 * Day)])
    expect(lease).toEqual({ key: 'k', token: args[0], fencingToken: 1_700_000_000_000_001, expiresAt: start + 1001 })
  })

  // `{{tenant}:orders}:fence` would hash `{tenant` and land in another slot than the lock key.
  it.each([
    ['{tenant}:orders', '{tenant}:orders:fence'],
    ['orders:{tenant}:rebuild', 'orders:{tenant}:rebuild:fence'],
    ['orders:rebuild', '{orders:rebuild}:fence'],
  ])('keeps the fence of "%s" in its slot as "%s"', async (key, fence) => {
    const client = stubClient('1')

    await new RedisLockBackend(client).tryAcquire(key, TTL)

    expect(client.eval.mock.calls[0][1].keys).toEqual([key, fence])
  })

  it('keeps the fence under the key the options name', async () => {
    const client = stubClient('1')

    await new RedisLockBackend(client, { fenceKey: key => `fence:{${key}}` }).tryAcquire('k', TTL)

    expect(client.eval.mock.calls[0][1].keys).toEqual(['k', 'fence:{k}'])
  })

  it('hands out no lease when the key is held', async () => {
    const client = stubClient(null)

    expect(await new RedisLockBackend(client).tryAcquire('k', TTL)).toBeUndefined()
  })

  it('asks nothing of the server once the signal has aborted', async () => {
    const client = stubClient()

    await expect(new RedisLockBackend(client).tryAcquire('k', TTL, AbortSignal.abort())).rejects.toThrow()
    expect(client.eval).not.toHaveBeenCalled()
  })

  it('extends a lease it still holds, keeping its fencing token, for the ttl in whole milliseconds rounded up', async () => {
    const client = stubClient()
    const start = Date.now()
    const lease = { key: 'k', token: 't', fencingToken: 7, expiresAt: start }

    const extended = await new RedisLockBackend(client).extend(lease, TTL)

    expect(client.eval.mock.calls[0][1]).toEqual({ keys: ['k'], arguments: ['t', '1001'] })
    expect(extended).toEqual({ key: 'k', token: 't', fencingToken: 7, expiresAt: start + 1001 })
  })

  it('extends nothing once another holder has the key', async () => {
    const client = stubClient(0)

    expect(
      await new RedisLockBackend(client).extend({ key: 'k', token: 't', fencingToken: 1, expiresAt: 0 }, TTL),
    ).toBeUndefined()
  })

  // A release the lock service gave up on is given back later with the same token; one that still went out now
  // could land after that and race it.
  it('sends no release once the signal has aborted', async () => {
    const client = stubClient()
    const lease = { key: 'k', token: 't', expiresAt: Date.now() + TTL }

    await expect(new RedisLockBackend(client).release(lease, AbortSignal.abort())).rejects.toThrow()
    expect(client.eval).not.toHaveBeenCalled()
  })
})
