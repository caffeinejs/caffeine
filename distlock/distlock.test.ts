import { CaffeineIoC } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import { afterEach, describe, expect, it } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLock } from './distlock.js'
import { ErrLockNotAcquired } from './errors.js'
import { kDistLock } from './keys.js'
import { distlock } from './plugin.js'

/** Records what reached the backend, so the caller's signal can be followed all the way down. */
class RecordingBackend implements Backend {
  readonly signals: Array<AbortSignal | undefined> = []

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttlMs: number, signal?: AbortSignal): Promise<LockLease | undefined> {
    this.signals.push(signal)

    return this.#inner.tryAcquire(key, ttlMs)
  }

  extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined> {
    return this.#inner.extend(lease, ttlMs)
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

let close: (() => Promise<unknown>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

async function newLock(backend: Backend = new MemoryLockBackend()): Promise<DistLock> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).with(
    distlock(d => d.backend(backend)),
  )

  await app.ready()
  close = () => app.close()

  return app.container.get(kDistLock)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('distributed lock', () => {
  // The claim the whole package makes: while one holder has the key, nobody else gets it.
  it('refuses a second holder while the key is taken', async () => {
    const lock = await newLock()

    const held = await lock.tryAcquire('orders:rebuild')

    expect(held).toBeDefined()
    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
  })

  it('retries until the holder gives the key back, inside the wait budget', async () => {
    const lock = await newLock()
    const held = await lock.acquire('orders:rebuild', { ttl: '1m' })

    setTimeout(() => void held.release(), 30)

    const second = await lock.acquire('orders:rebuild', { wait: '2s', retryDelay: 5 })

    expect(second.key).toBe('orders:rebuild')
    expect(second.token).not.toBe(held.token)
  })

  // Giving up has to be loud and has to say which key, or a caller cannot tell one stuck lock from another.
  it('throws ErrLockNotAcquired naming the key once the wait budget is spent', async () => {
    const lock = await newLock()
    await lock.acquire('orders:rebuild', { ttl: '1m' })

    const error = await lock.acquire('orders:rebuild', { wait: 50, retryDelay: 5 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrLockNotAcquired)
    expect((error as ErrLockNotAcquired).code).toBe('ERR_LOCK_NOT_ACQUIRED')
    expect((error as Error).message).toContain('"orders:rebuild"')
  })

  it('makes a single attempt when the wait budget is zero', async () => {
    const lock = await newLock()
    await lock.acquire('orders:rebuild', { ttl: '1m' })

    await expect(lock.acquire('orders:rebuild', { wait: 0 })).rejects.toBeInstanceOf(ErrLockNotAcquired)
  })

  // The correctness rule a distributed lock lives or dies on: a holder whose lease already lapsed must not be
  // able to unlock the replica that took the key over. An unconditional delete fails right here.
  it('does not let a lapsed holder release the key its successor now holds', async () => {
    const lock = await newLock()

    const lapsed = await lock.acquire('orders:rebuild', { ttl: 20 })
    await sleep(40)
    const successor = await lock.acquire('orders:rebuild', { ttl: '1m' })

    await lapsed.release()

    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    expect(successor.lost).toBe(false)
  })

  it('reports a lost lease from extend rather than pretending it was renewed', async () => {
    const lock = await newLock()

    const lapsed = await lock.acquire('orders:rebuild', { ttl: 20 })
    await sleep(40)
    await lock.acquire('orders:rebuild', { ttl: '1m' })

    expect(await lapsed.extend('1m')).toBe(false)
    expect(lapsed.lost).toBe(true)
  })

  it('releases the key when the action throws, and lets the original error through', async () => {
    const lock = await newLock()
    const boom = new Error('boom')

    await expect(lock.withLock('orders:rebuild', () => Promise.reject(boom))).rejects.toBe(boom)

    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('releases the key when the action returns', async () => {
    const lock = await newLock()

    await expect(lock.withLock('orders:rebuild', () => 'done')).resolves.toBe('done')

    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('releases at the end of an `await using` block', async () => {
    const lock = await newLock()

    {
      await using held = await lock.acquire('orders:rebuild', { ttl: '1m' })

      expect(held.lost).toBe(false)
      expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    }

    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  // Renewal is the only thing standing between a long critical section and a lease that lapses under it.
  it('keeps the key past its original lease while renewal is on', async () => {
    const lock = await newLock()

    await lock.acquire('orders:rebuild', { ttl: 60, renew: true })
    await sleep(150)

    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
  })

  // An explicit extend is a decision about this lock, not about this one tick of it: renewal must carry the
  // new duration rather than reverting to whatever `acquire` was called with.
  it('renews on the duration an explicit extend asked for', async () => {
    const lock = await newLock()

    const held = await lock.acquire('orders:rebuild', { ttl: 1_000, renew: true })
    expect(await held.extend(3_000)).toBe(true)

    // Past the first renewal, which was armed for a third of the original second.
    await sleep(400)

    expect(held.expiresAt - Date.now()).toBeGreaterThan(2_000)
  })

  it('hands the caller signal to the backend', async () => {
    const backend = new RecordingBackend()
    const lock = await newLock(backend)
    const controller = new AbortController()

    await lock.tryAcquire('orders:rebuild', { signal: controller.signal })

    // Identity, not equality: two distinct unaborted signals compare equal structurally.
    expect(backend.signals).toHaveLength(1)
    expect(backend.signals[0]).toBe(controller.signal)
  })

  it('stops waiting when the caller aborts', async () => {
    const lock = await newLock()
    await lock.acquire('orders:rebuild', { ttl: '1m' })

    const controller = new AbortController()
    const waiting = lock.acquire('orders:rebuild', { wait: '10s', retryDelay: 5, signal: controller.signal })
    const reason = new Error('caller went away')

    setTimeout(() => controller.abort(reason), 20)

    await expect(waiting).rejects.toBe(reason)
  })
})
