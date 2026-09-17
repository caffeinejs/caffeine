import { describe, expect, it } from 'vitest'

import { MemoryLockBackend } from './index.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('MemoryLockBackend', () => {
  it('hands out a lease good until the requested duration has passed', async () => {
    const backend = new MemoryLockBackend()
    const before = Date.now()

    const lease = await backend.tryAcquire('k', 1_000)

    expect(lease?.key).toBe('k')
    expect(lease?.token).toBeTypeOf('string')
    expect(lease!.expiresAt).toBeGreaterThanOrEqual(before + 1_000)
  })

  it('turns down a second acquisition while the first lease is good', async () => {
    const backend = new MemoryLockBackend()
    await backend.tryAcquire('k', 1_000)

    expect(await backend.tryAcquire('k', 1_000)).toBeUndefined()
  })

  it('hands the key to the next caller once the lease has lapsed', async () => {
    const backend = new MemoryLockBackend()
    await backend.tryAcquire('k', 20)

    await sleep(40)

    expect(await backend.tryAcquire('k', 1_000)).toBeDefined()
  })

  it('gives each holder a token of its own', async () => {
    const backend = new MemoryLockBackend()
    const first = await backend.tryAcquire('k', 20)
    await sleep(40)
    const second = await backend.tryAcquire('k', 1_000)

    expect(second!.token).not.toBe(first!.token)
  })

  // The two rules the SPI puts on every backend, in the one implementation that ships: a token that no longer
  // matches must neither extend nor release.
  it('refuses to extend a lease whose token no longer matches', async () => {
    const backend = new MemoryLockBackend()
    const lapsed = (await backend.tryAcquire('k', 20))!
    await sleep(40)
    await backend.tryAcquire('k', 1_000)

    expect(await backend.extend(lapsed, 1_000)).toBeUndefined()
  })

  it('refuses to release a key whose token no longer matches', async () => {
    const backend = new MemoryLockBackend()
    const lapsed = (await backend.tryAcquire('k', 20))!
    await sleep(40)
    await backend.tryAcquire('k', 1_000)

    await backend.release(lapsed)

    expect(await backend.tryAcquire('k', 1_000)).toBeUndefined()
  })

  it('extends a lease whose token still matches, and frees the key when its holder releases', async () => {
    const backend = new MemoryLockBackend()
    const lease = (await backend.tryAcquire('k', 30))!

    const extended = await backend.extend(lease, 1_000)
    expect(extended!.expiresAt).toBeGreaterThan(lease.expiresAt)

    await sleep(40)
    expect(await backend.tryAcquire('k', 1_000)).toBeUndefined()

    await backend.release(extended!)
    expect(await backend.tryAcquire('k', 1_000)).toBeDefined()
  })
})
