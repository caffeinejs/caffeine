import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend, RotatingBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLock } from './distlock.js'
import { ErrLockBackendTimeout } from './errors.js'
import { kDistLock } from './keys.js'
import { DistributedLock } from './plugin.js'

/**
 * Counts renewals, so a timer that outlived the application it belongs to is visible.
 *
 * `extend` takes real time on purpose: a renewal that is already on the wire is the case shutdown has to
 * handle, and a backend answering synchronously never produces one.
 */
class CountingBackend implements Backend {
  /** Renewals sent. */
  extensions = 0

  /** Renewals answered. Below {@link extensions} exactly while one is on the wire. */
  settled = 0

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.#inner.tryAcquire(key, ttl)
  }

  async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    this.extensions += 1
    await sleep(50)

    const next = await this.#inner.extend(lease, ttl)
    this.settled += 1

    return next
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

/** Holds every acquisition until the test opens it, and counts what reached the backend. */
class HeldAcquisitionBackend implements Backend {
  attempts = 0
  extensions = 0

  readonly #inner = new MemoryLockBackend()
  readonly #gate = Promise.withResolvers<void>()

  open(): void {
    this.#gate.resolve()
  }

  async tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    this.attempts += 1
    await this.#gate.promise
    return this.#inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    this.extensions += 1
    return this.#inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync()
  }
  vi.useRealTimers()

  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

async function newApp(backend: Backend): Promise<{ lock: DistLock; close: () => Promise<void> }> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
    DistributedLock(d => d.backend(backend)),
  )

  await app.bootstrap()
  opened.push(() => app.close())

  return { lock: app.container.get(kDistLock), close: () => app.close() }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('distlock lifecycle', () => {
  // An unref'd timer cannot hold the process open, but one left behind still fires a loss nobody can act on.
  it('lets no deadline timer keep the process alive after the lock is released', async () => {
    const { lock } = await newApp(new MemoryLockBackend())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 1 * Minute })
    expect(vi.getTimerCount()).toBe(1)

    await held.release()

    expect(vi.getTimerCount()).toBe(0)
  })

  // A renewal timer that keeps firing after the container is disposed is a leak that also keeps writing to a
  // backend the application no longer owns. The close lands while a renewal is in flight, which is the case
  // clearing the pending timer cannot reach: that renewal has already left, and it is the one that would
  // arm the next timer.
  it('stops renewing once the application is closed', async () => {
    const backend = new CountingBackend()
    const { lock, close } = await newApp(backend)

    // Renews at a third of the lease, so the first renewal leaves at ~100ms and answers 50ms later.
    await lock.acquire('orders:rebuild', { ttl: 300, renew: true })
    await sleep(110)

    // Precondition: one renewal is on the wire, unanswered. Without it this test proves nothing.
    expect(backend.extensions).toBe(1)
    expect(backend.settled).toBe(0)

    await close()

    // Disposal waited for it, so the application no longer has a write outstanding.
    expect(backend.settled).toBe(1)

    const renewed = backend.extensions
    await sleep(400)

    expect(backend.extensions).toBe(renewed)
  })

  // Shutdown must not hand the window back: the whole point is that the next replica to come up, or the next
  // tick of the same schedule, still finds the work already claimed.
  it('leaves a once window standing after the application is closed', async () => {
    const backend = new MemoryLockBackend()
    const { lock, close } = await newApp(backend)

    await lock.once('nightly-report', () => 'done', { ttl: 1 * Minute })
    await close()

    expect(await backend.tryAcquire('nightly-report', 1_000)).toBeUndefined()
  })

  // `release()` waits for a renewal on the wire so its write cannot outlive the release; a renewal the backend
  // never answers must not turn that wait into forever.
  it('does not let release wait forever on a renewal the backend never answers', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    backend.hang.add('extend')
    // The first renewal leaves at a third of the lease and never comes back.
    await vi.advanceTimersByTimeAsync(10 * Second)

    let settled = false
    const releasing = held.release()
    void releasing.finally(() => (settled = true)).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(2 * 5 * Second)

    expect(settled).toBe(true)
    expect(backend.released.map(lease => lease.token)).toEqual([held.token])
  })

  it('closes the application within storeTimeout when a renewal is stuck', async () => {
    const backend = new FaultyBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    backend.hang.add('extend')
    await vi.advanceTimersByTimeAsync(10 * Second)

    let settled = false
    void close()
      .finally(() => (settled = true))
      .catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)

    expect(settled).toBe(true)
  })

  // A lease can be lost by its deadline while a renewal is still on the wire. That renewal can still write, so close
  // waits for it as it would for any other.
  it('waits on close for a renewal still on the wire after the lease was lost by its deadline', async () => {
    const backend = new FaultyBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 3 * Second, renew: true })
    backend.hang.add('extend')
    // The renewal leaves at 1s and never answers; an extend shortening the lease to 200ms ends it at 1.3s.
    await vi.advanceTimersByTimeAsync(1 * Second)
    await vi.advanceTimersByTimeAsync(100)
    void held.extend(200).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(200)
    expect(held.signal.aborted).toBe(true)

    let settled = false
    void close()
      .finally(() => (settled = true))
      .catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    // The renewal waits at most the 2s its lease had left when it left.
    await vi.advanceTimersByTimeAsync(1700)
    expect(settled).toBe(true)
  })

  // The release went out with the token the lock knew; the renewal that rotated it answered too late for the
  // release to use. Unless the late lease is given back, the key stays taken under a token nobody holds.
  it('gives back a renewal that lands after the lock was released, so a backend that rotates the token on extend leaves the key free', async () => {
    const rotating = new RotatingBackend()
    const backend = new FaultyBackend(rotating)
    const { lock } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    backend.late = ['extend']
    await vi.advanceTimersByTimeAsync(10 * Second)

    const releasing = held.release()
    await vi.advanceTimersByTimeAsync(5 * Second)
    await releasing

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(await rotating.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
  })

  // Once close resolved, the application may tear its client down. A renewal that answers after that must send
  // nothing: the release would run into a closed client, and the key it renewed lapses at its ttl anyway.
  it('sends no release for a renewal that answers after close resolved', async () => {
    const backend = new FaultyBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    backend.late = ['extend']
    await vi.advanceTimersByTimeAsync(10 * Second)

    const closing = close()
    await vi.advanceTimersByTimeAsync(5 * Second)
    await closing

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released).toEqual([])
  })

  it('sends no release for an acquisition that answers after close resolved', async () => {
    const backend = new FaultyBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    backend.late = ['acquire']
    const attempt = lock.tryAcquire('orders:rebuild').catch((e: unknown) => e)
    const closing = close()
    await vi.advanceTimersByTimeAsync(5 * Second)
    await closing
    expect(await attempt).toBeInstanceOf(ErrLockBackendTimeout)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released).toEqual([])
  })

  // Close resolved with an acquisition still waiting on the backend. Retrying it would write to a backend the
  // application may already have torn down.
  it('sends no further acquisition attempt once close resolved', async () => {
    const backend = new HeldAcquisitionBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const acquiring = lock.acquire('orders:rebuild', { wait: 1 * Minute }).catch((e: unknown) => e)
    await close()
    await vi.advanceTimersByTimeAsync(30 * Second)

    expect(backend.attempts).toBe(1)
    expect(await acquiring).toBeInstanceOf(ErrLockBackendTimeout)
  })

  it('starts no renewal for a lock whose acquisition answered after close resolved', async () => {
    const backend = new HeldAcquisitionBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const acquiring = lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    await close()
    backend.open()
    await acquiring
    await vi.advanceTimersByTimeAsync(20 * Second)

    expect(backend.extensions).toBe(0)
  })

  // The same hole as above, opened by the holder's own extend: it timed out, the holder let go, and the rotated
  // token arrived after the release went out under the old one.
  it('gives back an explicit extend that lands after the lock was released, so a backend that rotates the token on extend leaves the key free', async () => {
    const rotating = new RotatingBackend()
    const backend = new FaultyBackend(rotating)
    const { lock } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    const extending = held.extend(1 * Minute).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await extending

    await held.release()
    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(await rotating.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
  })

  it('releases with the token a renewal rotated', async () => {
    const backend = new RotatingBackend()
    const { lock } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    const first: LockLease = {
      key: held.key,
      token: held.token,
      fencingToken: held.fencingToken,
      expiresAt: held.expiresAt,
    }
    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(held.token).not.toBe(first.token)

    await held.release()
    const successor = await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)
    expect(successor).toBeDefined()

    await backend.release(first)
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeUndefined()
  })
})
