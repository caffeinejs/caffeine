import { Minute, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  // The lock service aborts a call it stopped waiting for. An aborted call that still wrote would hand out, keep
  // or free a key behind its caller's back.
  it("rejects with the signal's reason and changes nothing once the signal has aborted", async () => {
    const backend = new MemoryLockBackend()
    const reason = new Error('caller went away')
    const aborted = AbortSignal.abort(reason)

    await expect(backend.tryAcquire('free', 1_000, aborted)).rejects.toBe(reason)
    expect(await backend.tryAcquire('free', 1_000)).not.toBeUndefined()

    const lease = (await backend.tryAcquire('k', 30))!
    await expect(backend.extend(lease, 60_000, aborted)).rejects.toBe(reason)
    await expect(backend.release(lease, aborted)).rejects.toBe(reason)

    expect(await backend.tryAcquire('k', 1_000)).toBeUndefined()
    // Neither the aborted extend nor the aborted release touched the key: it lapses on its first ttl.
    await sleep(40)
    expect(await backend.tryAcquire('k', 1_000)).not.toBeUndefined()
  })
})

// A resource that remembers the highest token it has seen turns away a holder whose lease lapsed; that only works
// while every later acquisition of the key carries a greater token.
describe('MemoryLockBackend fencing tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('issues a greater token on every acquisition of a key, across release and expiry', async () => {
    const backend = new MemoryLockBackend()

    const first = (await backend.tryAcquire('k', 1 * Second))!
    await backend.release(first)
    const second = (await backend.tryAcquire('k', 1 * Second))!
    vi.advanceTimersByTime(2 * Second)
    const third = (await backend.tryAcquire('k', 1 * Second))!

    expect(Number.isSafeInteger(first.fencingToken)).toBe(true)
    expect(first.fencingToken).toBeGreaterThan(0)
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
    expect(third.fencingToken).toBeGreaterThan(second.fencingToken)
  })

  it('keeps the fencing token across extend', async () => {
    const backend = new MemoryLockBackend()
    const lease = (await backend.tryAcquire('k', 1 * Second))!

    const extended = await backend.extend(lease, 1 * Minute)

    expect(extended!.fencingToken).toBe(lease.fencingToken)
  })

  // A test or an application that builds a second backend in the same process must not hand out a token the
  // first one already issued, even after the wall clock steps back.
  it('keeps issuing greater tokens from a new instance after the clock steps back', async () => {
    const first = (await new MemoryLockBackend().tryAcquire('k', 1 * Second))!
    vi.setSystemTime(Date.now() - 1 * Minute)

    const second = (await new MemoryLockBackend().tryAcquire('k', 1 * Second))!

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
  })
})
