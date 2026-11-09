import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLock } from './distlock.js'
import { ErrInvalidLockKey, ErrLockBackendTimeout, ErrLockNotAcquired } from './errors.js'
import { kDistLock } from './keys.js'
import { RecordingLogger } from './log.testkit.js'
import { DistributedLock } from './plugin.js'

/**
 * Records what reached the backend, so the caller's signal can be followed all the way down. With `hang` set, an
 * attempt never answers, so a signal can abort while the call is still on the wire.
 */
class RecordingBackend implements Backend {
  readonly signals: Array<AbortSignal | undefined> = []
  hang = false

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    this.signals.push(signal)

    return this.hang ? new Promise(() => undefined) : this.#inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    return this.#inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

/** Hands every lease out already expired, while the inner backend keeps the key taken under it. */
class ExpiredInTransitBackend implements Backend {
  readonly inner = new MemoryLockBackend()

  async tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    const lease = await this.inner.tryAcquire(key, ttl)
    return lease === undefined ? undefined : { ...lease, expiresAt: Date.now() - 1 }
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    return this.inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.inner.release(lease)
  }
}

/** Never answers the first attempt; answers every later one. */
class FirstAttemptHangsBackend implements Backend {
  attempts = 0

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    this.attempts += 1
    return this.attempts === 1 ? new Promise(() => undefined) : this.#inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    return this.#inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

let close: (() => Promise<unknown>) | undefined

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync()
  }
  vi.useRealTimers()
  await close?.()
  close = undefined
})

async function newLock(backend: Backend = new MemoryLockBackend(), log?: RecordingLogger): Promise<DistLock> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), logger: log }).install(
    DistributedLock(d => d.backend(backend)),
  )

  await app.bootstrap()
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
    const held = await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

    setTimeout(() => void held.release(), 30)

    const second = await lock.acquire('orders:rebuild', { wait: 2 * Second, retryDelay: 5 })

    expect(second.key).toBe('orders:rebuild')
    expect(second.token).not.toBe(held.token)
  })

  // Giving up has to be loud and has to say which key, or a caller cannot tell one stuck lock from another.
  it('throws ErrLockNotAcquired naming the key once the wait budget is spent', async () => {
    const lock = await newLock()
    await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

    const error = await lock.acquire('orders:rebuild', { wait: 50, retryDelay: 5 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrLockNotAcquired)
    expect((error as ErrLockNotAcquired).code).toBe('ERR_LOCK_NOT_ACQUIRED')
    expect((error as Error).message).toContain('"orders:rebuild"')
  })

  it('makes a single attempt when the wait budget is zero', async () => {
    const lock = await newLock()
    await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

    await expect(lock.acquire('orders:rebuild', { wait: 0 })).rejects.toBeInstanceOf(ErrLockNotAcquired)
  })

  // The correctness rule a distributed lock lives or dies on: a holder whose lease already lapsed must not be
  // able to unlock the replica that took the key over. An unconditional delete fails right here.
  it('does not let a lapsed holder release the key its successor now holds', async () => {
    const lock = await newLock()

    const lapsed = await lock.acquire('orders:rebuild', { ttl: 20 })
    await sleep(40)
    const successor = await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

    await lapsed.release()

    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    expect(successor.lost).toBe(false)
  })

  it('reports a lost lease from extend rather than pretending it was renewed', async () => {
    const lock = await newLock()

    const lapsed = await lock.acquire('orders:rebuild', { ttl: 20 })
    await sleep(40)
    await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

    expect(await lapsed.extend(1 * Minute)).toBe(false)
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
      await using held = await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

      expect(held.lost).toBe(false)
      expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    }

    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  // Renewal is the only thing standing between a long critical section and a lease that lapses under it.
  it('keeps the key past its original lease while renewal is on', async () => {
    const lock = await newLock()
    // Renewals and the backend's expiry run on the fake clock, so a busy machine cannot make one late.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    await lock.acquire('orders:rebuild', { ttl: 60, renew: true })
    await vi.advanceTimersByTimeAsync(150)

    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
  })

  // An explicit extend is a decision about this lock, not about this one tick of it: renewal must carry the
  // new duration rather than reverting to whatever `acquire` was called with.
  it('renews on the duration an explicit extend asked for', async () => {
    const lock = await newLock()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 1_000, renew: true })
    expect(await held.extend(3_000)).toBe(true)

    // Past the first renewal, which was armed for a third of the original second.
    await vi.advanceTimersByTimeAsync(400)

    expect(held.expiresAt - Date.now()).toBeGreaterThan(2_000)
  })

  // The backend gets a signal of its own, which also carries the deadline; a caller that gives up still has to
  // reach a backend that can cancel.
  it("aborts the backend's signal with the caller's reason", async () => {
    const backend = new RecordingBackend()
    backend.hang = true
    const lock = await newLock(backend)
    const controller = new AbortController()
    const reason = new Error('caller went away')

    const attempt = lock.tryAcquire('orders:rebuild', { signal: controller.signal })
    controller.abort(reason)

    await expect(attempt).rejects.toBe(reason)
    expect(backend.signals).toHaveLength(1)
    expect(backend.signals[0]?.aborted).toBe(true)
    expect(backend.signals[0]?.reason).toBe(reason)
  })

  it('stops waiting when the caller aborts', async () => {
    const lock = await newLock()
    await lock.acquire('orders:rebuild', { ttl: 1 * Minute })

    const controller = new AbortController()
    const waiting = lock.acquire('orders:rebuild', { wait: 10 * Second, retryDelay: 5, signal: controller.signal })
    const reason = new Error('caller went away')

    setTimeout(() => controller.abort(reason), 20)

    await expect(waiting).rejects.toBe(reason)
  })
})

describe('distributed lock against a backend that does not answer', () => {
  // A hung store must not hang its callers: every backend call has a deadline, `storeTimeout` by default.
  it("gives up on a backend that never answers after storeTimeout, with an ErrLockBackendTimeout whose operation is 'acquire'", async () => {
    const backend = new FaultyBackend()
    backend.hang.add('acquire')
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    let settled = false
    const attempt = lock.tryAcquire('orders:rebuild').catch((e: unknown) => e)
    void attempt.finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(5 * Second)

    expect(settled).toBe(true)
    const error = await attempt
    expect(error).toBeInstanceOf(ErrLockBackendTimeout)
    expect((error as ErrLockBackendTimeout).code).toBe('ERR_LOCK_BACKEND_TIMEOUT')
    expect((error as ErrLockBackendTimeout).operation).toBe('acquire')
  })

  // A lease nobody is waiting for any more would keep the key taken for its whole ttl, with no holder.
  it('gives a lease back when the backend answers after the caller gave up', async () => {
    const backend = new FaultyBackend()
    backend.late = ['acquire']
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    let settled = false
    const attempt = lock.tryAcquire('orders:rebuild', { ttl: 1 * Minute }).catch((e: unknown) => e)
    void attempt.finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(settled).toBe(true)
    expect(await attempt).toBeInstanceOf(ErrLockBackendTimeout)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released.map(lease => lease.key)).toEqual(['orders:rebuild'])
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  // A lease that is already over protects nothing; handing it out lets a caller act as the holder while another
  // replica takes the key.
  it('treats a lease that arrived already expired as not acquired, and gives it back', async () => {
    const backend = new ExpiredInTransitBackend()
    const lock = await newLock(backend)

    expect(await lock.tryAcquire('orders:rebuild', { ttl: 1 * Minute })).toBeUndefined()

    await vi.waitFor(async () => expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined())
  })

  it('keeps acquire retrying when one attempt timed out and the wait budget remains', async () => {
    const backend = new FirstAttemptHangsBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    let settled = false
    const acquiring = lock.acquire('orders:rebuild', { wait: 10 * Second })
    void acquiring.finally(() => (settled = true)).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(6 * Second)

    expect(settled).toBe(true)
    expect((await acquiring).key).toBe('orders:rebuild')
    expect(backend.attempts).toBe(2)
  })

  // A store that never answers is a different failure from a key somebody holds, and the caller is told so.
  it('rejects acquire with the timeout when its last attempt was not answered', async () => {
    const backend = new FaultyBackend()
    backend.hang.add('acquire')
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const acquiring = lock.acquire('orders:rebuild', { wait: 1 * Second }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)

    const error = await acquiring
    expect(error).toBeInstanceOf(ErrLockBackendTimeout)
    expect((error as ErrLockBackendTimeout).operation).toBe('acquire')
  })

  // A backend whose clock runs ahead hands every attempt an expired lease: that is one incident, not one per attempt.
  it('keeps acquire retrying past leases that arrived expired, and warns once', async () => {
    const backend = new ExpiredInTransitBackend()
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)

    const error = await lock.acquire('orders:rebuild', { wait: 100, retryDelay: 5 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrLockNotAcquired)
    expect(log.at('warn').map(record => record.msg)).toEqual([
      'lock lease expired in transit',
      'lock acquisition timed out',
    ])
  })

  // An explicit extend the store answered late still moved the key's expiry; the lock must carry that lease.
  it('adopts the lease of an explicit extend that answered late', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const before = held.expiresAt
    backend.late = ['extend']

    const extending = held.extend(10 * Minute).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.expiresAt).toBe(before + 10 * Minute - 30 * Second)
    expect(backend.released).toEqual([])
  })

  it('refuses an empty key with ErrInvalidLockKey before touching the backend', async () => {
    const backend = new RecordingBackend()
    const lock = await newLock(backend)

    const error = await lock.tryAcquire('').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrInvalidLockKey)
    expect((error as ErrInvalidLockKey).code).toBe('ERR_INVALID_LOCK_KEY')
    await expect(lock.acquire('')).rejects.toBeInstanceOf(ErrInvalidLockKey)
    await expect(lock.withLock('', () => 'never')).rejects.toBeInstanceOf(ErrInvalidLockKey)
    await expect(lock.once(undefined as unknown as string, () => 'never')).rejects.toBeInstanceOf(ErrInvalidLockKey)
    expect(backend.signals).toHaveLength(0)
  })

  // The action already ran and its result is what the caller asked for; the lease lapses on its own.
  it("resolves withLock with the action's result when only the release timed out, and warns once", async () => {
    const backend = new FaultyBackend()
    backend.hang.add('release')
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    let settled = false
    const running = lock.withLock('orders:rebuild', () => 'done')
    void running.finally(() => (settled = true)).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)

    expect(settled).toBe(true)
    await expect(running).resolves.toBe('done')
    expect(log.at('warn').map(record => [record.msg, record.fields.operation])).toEqual([
      ['lock backend failed', 'release'],
    ])
  })
})
