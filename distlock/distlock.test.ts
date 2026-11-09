import { createApplication } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC } from '@caffeinejs/di'
import { Day, Millisecond, Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend, RenumberingBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import { CaffeineDistLock, type AcquireOptions, type DistLock, type Lock } from './distlock.js'
import {
  ErrDistLockConfiguration,
  ErrInvalidLockKey,
  ErrLockBackendContract,
  ErrLockBackendTimeout,
  ErrLockLost,
  ErrLockNotAcquired,
  ErrLockReleased,
} from './errors.js'
import { kDistLock } from './keys.js'
import { RecordingLogger } from './log.testkit.js'
import type { LostMessage } from './observability/channels.js'
import { DEFAULT_DIST_LOCK_OPTIONS } from './options.js'
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

/** Counts the extends and releases that reach the backend, and fails the first `failures` extends. */
class CountingBackend implements Backend {
  extends = 0
  releases = 0
  failures = 0

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.#inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    this.extends += 1
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error('backend down'))
    }

    return this.#inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    this.releases += 1
    return this.#inner.release(lease)
  }
}

/** Answers every renewal with "taken" exactly when the lease lapses, so the clock and the renewal notice together. */
class TakenAtExpiryBackend implements Backend {
  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.#inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease): Promise<LockLease | undefined> {
    return new Promise(resolve => setTimeout(() => resolve(undefined), lease.expiresAt - Date.now()))
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

/** Records when each attempt reached the backend, so a test can read the pauses between them. */
class TimedBackend implements Backend {
  readonly attempts: number[] = []
  readonly inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    this.attempts.push(Date.now())
    return this.inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    return this.inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.inner.release(lease)
  }

  pauses(): number[] {
    return this.attempts.slice(1).map((at, i) => at - this.attempts[i])
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

async function newTunedLock(backend: Backend, tune: (d: DistLockBuilder) => DistLockBuilder): Promise<DistLock> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
    DistributedLock(d => tune(d.backend(backend))),
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

  // Redis keeps the token on extend: releasing a superseded answer would free the key the lock still holds.
  it('keeps the key when a superseded extend under the same token answers late', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    const stale = held.extend(1 * Minute).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await stale

    backend.late = []
    expect(await held.extend(10 * Minute)).toBe(true)
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released).toEqual([])
    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
  })

  // The timeout already warned about the incident; what the backend says after it is a consequence, not a second
  // one, and a warning per late answer would double every alert.
  it('logs a late extend failure at debug, after the one warning its timeout gave', async () => {
    const inner = new FaultyBackend()
    const backend = new FaultyBackend(inner)
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    inner.failExtend = true
    const extending = held.extend(1 * Minute).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)

    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(log.at('warn').map(record => record.msg)).toEqual(['lock backend failed'])
    expect(log.at('debug').filter(record => record.msg === 'lock backend failed late')).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ operation: 'extend', key: 'orders:rebuild' }) }),
    ])
  })

  it('logs a late release failure at debug, after the one warning its timeout gave', async () => {
    const inner = new FaultyBackend()
    const backend = new FaultyBackend(inner)
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['release']
    inner.failRelease = true
    const releasing = held.release().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await releasing).toBeInstanceOf(ErrLockBackendTimeout)

    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(log.at('warn').map(record => record.msg)).toEqual(['lock backend failed'])
    expect(log.at('debug').filter(record => record.msg === 'lock backend failed late')).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ operation: 'release', key: 'orders:rebuild' }) }),
    ])
  })

  it('logs a late acquisition failure at debug, after the one warning its timeout gave', async () => {
    const inner = new FaultyBackend()
    const backend = new FaultyBackend(inner)
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    backend.late = ['acquire']
    inner.failAcquire = true
    const attempt = lock.tryAcquire('orders:rebuild').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await attempt).toBeInstanceOf(ErrLockBackendTimeout)

    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(log.at('warn').map(record => record.msg)).toEqual(['lock backend failed'])
    expect(log.at('debug').filter(record => record.msg === 'lock backend failed late')).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ operation: 'acquire', key: 'orders:rebuild' }) }),
    ])
  })

  // A late answer saying the key is gone carries no lease: there is nothing to give back, and the lock it belongs
  // to keeps its key.
  it('gives nothing back when an extend answers late that the key was taken', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    backend.stolen = true
    const extending = held.extend(1 * Minute).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await extending

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released).toEqual([])
    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
  })

  // Somebody else held the key when the late attempt landed: releasing anything here could only free their key.
  it('gives nothing back when an acquisition answers late that the key was held', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const other = await lock.acquire('orders:rebuild', { ttl: 1 * Minute })
    backend.late = ['acquire']
    const attempt = lock.tryAcquire('orders:rebuild').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await attempt).toBeInstanceOf(ErrLockBackendTimeout)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released).toEqual([])
    expect(other.lost).toBe(false)
  })

  // The give-back is housekeeping after an incident already reported; when it fails too, the lease lapses on its
  // own and nobody is woken for it.
  it('logs a failed give-back at debug and lets the lease lapse', async () => {
    const backend = new FaultyBackend()
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    backend.late = ['acquire']
    const attempt = lock.tryAcquire('orders:rebuild', { ttl: 1 * Minute }).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await attempt

    backend.late = []
    backend.failRelease = true
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(log.at('debug').filter(record => record.msg === 'lock lease give-back failed')).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ key: 'orders:rebuild' }) }),
    ])
    expect(log.at('warn').map(record => record.msg)).toEqual(['lock backend failed'])
  })

  // A store that stopped answering is one incident however many attempts run into it.
  it('warns once when several attempts of one acquisition time out', async () => {
    const backend = new FaultyBackend()
    backend.hang.add('acquire')
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const acquiring = lock.acquire('orders:rebuild', { wait: 12 * Second }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(30 * Second)

    expect(await acquiring).toBeInstanceOf(ErrLockBackendTimeout)
    expect(log.at('warn').filter(record => record.msg === 'lock backend failed')).toHaveLength(1)
    expect(log.at('debug').filter(record => record.msg === 'lock backend failed')).toHaveLength(2)
  })

  // When the lease is shorter than storeTimeout, the lease is what cut the wait short, and raising storeTimeout
  // would change nothing: the message names the setting that does.
  it('names ttl as the setting to raise when the lease bounded the wait', async () => {
    const backend = new FaultyBackend()
    backend.hang.add('acquire')
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const attempt = lock.tryAcquire('orders:rebuild', { ttl: 1 * Second }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1 * Second)

    const error = (await attempt) as ErrLockBackendTimeout
    expect(error).toBeInstanceOf(ErrLockBackendTimeout)
    expect(error.timeout).toBe(1 * Second)
    expect(error.message).toContain('Raise ttl, such as { ttl: 60 * Second }')
    expect(error.message).not.toContain('Raise storeTimeout')
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

describe('lock signal', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  function lossOf(lock: Lock): ErrLockLost {
    expect(lock.signal.aborted).toBe(true)
    expect(lock.signal.reason).toBeInstanceOf(ErrLockLost)
    expect((lock.signal.reason as ErrLockLost).code).toBe('ERR_LOCK_LOST')
    return lock.signal.reason as ErrLockLost
  }

  // Loss has to stop work, not wait to be read: the deadline aborts the signal on its own.
  it('aborts lock.signal with ErrLockLost(expired) when the lease lapses with renewal off, without any backend call', async () => {
    const backend = new CountingBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 1 * Second })
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(lossOf(held).reason).toBe('expired')
    expect([backend.extends, backend.releases]).toEqual([0, 0])
  })

  // `setTimeout` turns a delay past 2^31 - 1 ms (about 24.8 days) into 1 ms. Armed in one step, a month-long
  // lease would be reported lost the moment it was taken.
  it('keeps a lease longer than the longest timer until it actually lapses', async () => {
    const lock = await newLock()
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Day })
    await vi.advanceTimersByTimeAsync(25 * Day)
    expect(held.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(5 * Day)
    expect(lossOf(held).reason).toBe('expired')
  })

  it('aborts lock.signal with ErrLockLost(taken) when a renewal finds the key gone', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 3 * Second, renew: true })
    backend.stolen = true
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(lossOf(held).reason).toBe('taken')
  })

  // One failed round trip to the store is not a lost lease while the lease still has time to be renewed.
  it('keeps renewing through a transient backend failure while the lease still has time, and aborts with error once it does not', async () => {
    const backend = new CountingBackend()
    const lock = await newLock(backend)
    fake()

    const transient = await lock.acquire('orders:transient', { ttl: 30 * Second, renew: true })
    backend.failures = 1
    await vi.advanceTimersByTimeAsync(30 * Second)

    expect(transient.lost).toBe(false)
    expect(transient.signal.aborted).toBe(false)
    await transient.release()

    const persistent = await lock.acquire('orders:persistent', { ttl: 30 * Second, renew: true })
    backend.failures = Number.POSITIVE_INFINITY
    // The lease has 5s, storeTimeout, left at 25s: the retries stop there, before it expires at 30s.
    await vi.advanceTimersByTimeAsync(26 * Second)

    expect(lossOf(persistent).reason).toBe('error')
    expect(Date.now()).toBeLessThan(persistent.expiresAt)
  })

  it('aborts lock.signal with ErrLockReleased after release, and keeps a loss reason over a later release', async () => {
    const lock = await newLock()
    fake()

    const released = await lock.acquire('orders:released', { ttl: 1 * Minute })
    await released.release()

    expect(released.signal.reason).toBeInstanceOf(ErrLockReleased)
    expect((released.signal.reason as ErrLockReleased).code).toBe('ERR_LOCK_RELEASED')

    const lapsed = await lock.acquire('orders:lapsed', { ttl: 1 * Second })
    await vi.advanceTimersByTimeAsync(1 * Second)
    await lapsed.release()

    expect(lossOf(lapsed).reason).toBe('expired')
  })

  it('publishes exactly one lost message per lease when the clock and a renewal both notice', async () => {
    const lock = await newLock(new TakenAtExpiryBackend())
    const lost: LostMessage[] = []
    lock.events.on('lost', message => lost.push(message))
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 3 * Second, renew: true })
    await vi.advanceTimersByTimeAsync(5 * Second)

    expect(held.signal.aborted).toBe(true)
    expect(lost.length).toBe(1)
  })

  it("hands once's action the lock, so it can watch the window", async () => {
    const lock = await newLock()
    let seen: Lock | undefined

    const result = await lock.once('nightly-report', held => {
      seen = held
      return held.signal.aborted
    })

    expect(result).toEqual({ executed: true, result: false })
    expect(seen?.key).toBe('nightly-report')
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
    // The window it left standing is the lease it was handed.
    expect(await lock.tryAcquire('nightly-report')).toBeUndefined()
  })

  // One warning per incident: retries of the same failure are its consequences, a later failure is a new one.
  it('warns once for a renewal that keeps failing, and again after one succeeded in between', async () => {
    const backend = new CountingBackend()
    const log = new RecordingLogger()
    const lock = await newLock(backend, log)
    fake()

    await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    backend.failures = 2
    await vi.advanceTimersByTimeAsync(11 * Second)
    backend.failures = 1
    await vi.advanceTimersByTimeAsync(10 * Second)

    const failed = (level: 'warn' | 'debug') =>
      log.at(level).filter(record => record.msg === 'lock backend failed' && record.fields.operation === 'extend')
    expect(failed('warn')).toHaveLength(2)
    expect(failed('debug')).toHaveLength(1)
  })

  // A renewal the lock stopped waiting for still moved the key's expiry; while nothing replaced the lease, the
  // lock carries the answer.
  it('adopts a timed-out renewal that answers late while the lease is unchanged', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    const acquired = Date.now()
    backend.late = ['extend']
    // The renewal leaves at 10s and is given up on at 15s; the answer lands before the retry leaves.
    await vi.advanceTimersByTimeAsync(15 * Second)
    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.expiresAt).toBe(acquired + 10 * Second + 30 * Second)
    expect(backend.released).toEqual([])
    expect(held.signal.aborted).toBe(false)
  })

  it('gives back the late answer of a renewal that gave up', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 12 * Second, renew: true })
    backend.late = ['extend']
    // Sent at 4s with 8s left, given up on at 9s with 3s left: under storeTimeout, so no retry.
    await vi.advanceTimersByTimeAsync(9 * Second)
    expect(lossOf(held).reason).toBe('error')

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.released.map(lease => lease.key)).toEqual(['orders:rebuild'])
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('re-arms the deadline after an explicit extend', async () => {
    const lock = await newLock()
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 1 * Second })
    expect(await held.extend(5 * Second)).toBe(true)
    await vi.advanceTimersByTimeAsync(2 * Second)

    expect(held.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(3 * Second)

    expect(lossOf(held).reason).toBe('expired')
  })

  // The window is not the holder's any more: its lapsing is the design, not a loss.
  it('publishes nothing when a once window lapses after its action returned', async () => {
    const lock = await newLock()
    const lost: LostMessage[] = []
    lock.events.on('lost', message => lost.push(message))
    fake()

    let seen: Lock | undefined
    await lock.once('nightly-report', held => void (seen = held), { ttl: 1 * Second })
    await vi.advanceTimersByTimeAsync(2 * Second)

    expect(seen?.signal.aborted).toBe(false)
    expect(lost).toEqual([])
  })

  it('still warns once when a once action outlives its lease', async () => {
    const log = new RecordingLogger()
    const lock = await newLock(new MemoryLockBackend(), log)
    fake()

    const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
    const running = lock.once('nightly-report', () => finished, { ttl: 1 * Second })
    await vi.advanceTimersByTimeAsync(2 * Second)
    finish()
    await running

    expect(log.at('warn').map(record => record.msg)).toEqual(['lock once outlived its lease'])
  })

  // `setTimeout` fires a delay above 2^31 - 1 ms after 1 ms; a long window must not be reported lost at once.
  it('keeps a once window with a ttl beyond 24.8 days standing', async () => {
    const lock = await newLock()
    const lost: LostMessage[] = []
    lock.events.on('lost', message => lost.push(message))
    fake()

    let aborted: boolean | undefined
    await lock.once(
      'yearly-report',
      async held => {
        await vi.advanceTimersByTimeAsync(1 * Second)
        aborted = held.signal.aborted
      },
      { ttl: 30 * 24 * 60 * Minute },
    )
    await vi.advanceTimersByTimeAsync(25 * 24 * 60 * Minute)

    expect(aborted).toBe(false)
    expect(lost).toEqual([])
    expect(await lock.tryAcquire('yearly-report')).toBeUndefined()
  })
})

// A fencing token is what a resource uses to turn away a holder whose lease lapsed. A token the resource cannot
// order, or one that changes under the holder, would let a stale write through, so it never reaches the caller.
describe('fencing tokens', () => {
  it('exposes the token the backend issued, greater on every acquisition of the key', async () => {
    const lock = await newLock()

    const first = await lock.acquire('orders:rebuild')
    await first.release()
    const second = await lock.acquire('orders:rebuild')

    expect(Number.isSafeInteger(first.fencingToken)).toBe(true)
    expect(first.fencingToken).toBeGreaterThan(0)
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
    await second.release()
  })

  it('refuses a lease whose fencing token is not a positive integer, and gives the key back', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    backend.badFencing = true

    const refused = lock.tryAcquire('orders:rebuild')

    await expect(refused).rejects.toBeInstanceOf(ErrLockBackendContract)
    await expect(refused).rejects.toMatchObject({ code: 'ERR_LOCK_BACKEND_CONTRACT', key: 'orders:rebuild' })
    backend.badFencing = false
    expect(await lock.tryAcquire('orders:rebuild')).not.toBeUndefined()
  })

  it('refuses an extend that changed the fencing token, aborts the lock and gives the key back', async () => {
    const backend = new RenumberingBackend()
    const lock = await newLock(backend)
    const held = await lock.acquire('orders:rebuild')

    await expect(held.extend(1 * Minute)).rejects.toBeInstanceOf(ErrLockBackendContract)

    expect(held.signal.aborted).toBe(true)
    expect((held.signal.reason as ErrLockLost).reason).toBe('error')
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).not.toBeUndefined()
  })

  it('loses the lock when a renewal changed the fencing token, and gives the key back', async () => {
    const backend = new RenumberingBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 3 * Second, renew: true })
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect((held.signal.reason as ErrLockLost).reason).toBe('error')
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).not.toBeUndefined()
  })

  // A late answer is the same answer: one that renumbers the lease is refused as an on-time one is, never adopted
  // and never silently dropped.
  it('loses the lock when an extend that answered late changed the fencing token, and gives the key back', async () => {
    const renumbering = new RenumberingBackend()
    const backend = new FaultyBackend(renumbering)
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    const extending = held.extend(10 * Minute).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect((held.signal.reason as ErrLockLost).reason).toBe('error')
    expect(await renumbering.inner.tryAcquire('orders:rebuild', 1 * Minute)).not.toBeUndefined()
  })
})

// Under sustained contention a fixed pause either hammers the store or reacts slowly; doubling up to a cap does
// neither. Jitter is off so the schedule can be read exactly.
describe('acquisition backoff', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  async function contend(lock: DistLock, backend: TimedBackend, options: AcquireOptions = {}): Promise<number[]> {
    await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)
    const acquiring = lock.acquire('orders:rebuild', { wait: 4 * Second, ...options }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(4 * Second)
    expect(await acquiring).toBeInstanceOf(ErrLockNotAcquired)
    return backend.pauses()
  }

  it('grows the pause between attempts exponentially, capped at maxRetryDelay', async () => {
    const backend = new TimedBackend()
    const lock = await newTunedLock(backend, d => d.retryJitter(0))
    fake()

    const pauses = await contend(lock, backend)

    expect(pauses.slice(0, 7)).toEqual([50, 100, 200, 400, 800, 1000, 1000])
  })

  it('lets a call bring its own backoff', async () => {
    const backend = new TimedBackend()
    const lock = await newTunedLock(backend, d => d.retryJitter(0))
    fake()

    const pauses = await contend(lock, backend, { backoff: attempt => attempt * 300 * Millisecond })

    expect(pauses.slice(0, 4)).toEqual([300, 600, 900, 1200])
  })

  // A service-wide schedule is a default: a call that tunes the delays asked for the exponential one with them.
  it("applies the service's backoff only to a call that names no retry option", async () => {
    const backend = new TimedBackend()
    const lock = await newTunedLock(backend, d => d.retryJitter(0).backoff(() => 700 * Millisecond))
    fake()

    const pauses = await contend(lock, backend, { retryDelay: 200 * Millisecond, maxRetryDelay: 400 * Millisecond })

    expect(pauses.slice(0, 4)).toEqual([200, 400, 400, 400])
  })

  it("applies the service's backoff to a call that names no retry option", async () => {
    const backend = new TimedBackend()
    const lock = await newTunedLock(backend, d => d.retryJitter(0).backoff(() => 700 * Millisecond))
    fake()

    const pauses = await contend(lock, backend)

    expect(pauses.slice(0, 3)).toEqual([700, 700, 700])
  })

  it("lets a call's backoff win over its own retry delays", async () => {
    const backend = new TimedBackend()
    const lock = await newTunedLock(backend, d => d.retryJitter(0))
    fake()

    const pauses = await contend(lock, backend, { retryDelay: 10 * Millisecond, backoff: () => 900 * Millisecond })

    expect(pauses.slice(0, 3)).toEqual([900, 900, 900])
  })

  it('refuses a negative retry delay on a call with ErrDistLockConfiguration before any attempt', async () => {
    const backend = new TimedBackend()
    const lock = await newLock(backend)

    const error = await lock.acquire('orders:rebuild', { retryDelay: -1 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrDistLockConfiguration)
    expect(backend.attempts).toEqual([])
  })

  // A NaN from a botched computation would make every pause NaN, which `setTimeout` turns into 1 ms: a caller
  // hammering the backend instead of backing off.
  it('refuses a max retry delay that is not a number before any attempt', async () => {
    const backend = new TimedBackend()
    const lock = await newLock(backend)

    const error = await lock.acquire('orders:rebuild', { maxRetryDelay: Number.NaN }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrDistLockConfiguration)
    expect((error as ErrDistLockConfiguration).message).toContain('maxRetryDelay')
    expect(backend.attempts).toEqual([])
  })

  // The builder refuses it; a service constructed by hand has nothing in front of it but this.
  it('refuses a retry jitter of 1 on a service constructed by hand with ErrDistLockConfiguration', async () => {
    const backend = new TimedBackend()
    const lock = new CaffeineDistLock(backend, { ...DEFAULT_DIST_LOCK_OPTIONS, retryJitter: 1 }, newNoopLogger())

    await expect(lock.acquire('orders:rebuild')).rejects.toBeInstanceOf(ErrDistLockConfiguration)
    expect(backend.attempts).toEqual([])
  })
})

describe('tryWithLock', () => {
  it('runs the action when the key is free, and skips without waiting when it is held', async () => {
    const backend = new TimedBackend()
    const lock = await newLock(backend)

    expect(await lock.tryWithLock('orders:rebuild', held => held.key)).toEqual({
      executed: true,
      result: 'orders:rebuild',
    })

    const holder = await lock.acquire('orders:rebuild')
    backend.attempts.length = 0
    let ran = false
    expect(await lock.tryWithLock('orders:rebuild', () => (ran = true))).toEqual({ executed: false })
    expect(ran).toBe(false)
    expect(backend.attempts).toHaveLength(1)
    await holder.release()
  })

  it('releases after tryWithLock whether the action returned or threw', async () => {
    const lock = await newLock()

    await lock.tryWithLock('orders:rebuild', () => 'done')
    expect(await lock.tryAcquire('orders:rebuild')).not.toBeUndefined()

    await expect(
      lock.tryWithLock('orders:refund', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await lock.tryAcquire('orders:refund')).not.toBeUndefined()
  })
})

// A section is bounded by its scope, so renewing it by default cannot leak; a manual lease has no scope, so it
// renews only when asked.
describe('renewal defaults', () => {
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  it('renews a withLock section by default, so work outliving ttl keeps the key', async () => {
    const lock = await newLock()
    fake()

    let lost: boolean | undefined
    const section = lock.withLock(
      'orders:rebuild',
      async held => {
        await new Promise(resolve => setTimeout(resolve, 5 * Second))
        lost = held.lost
        expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
      },
      { ttl: 1 * Second },
    )
    await vi.advanceTimersByTimeAsync(5 * Second)
    await section

    expect(lost).toBe(false)
  })

  it('renews a tryWithLock section by default', async () => {
    const lock = await newLock()
    fake()

    let lost: boolean | undefined
    const section = lock.tryWithLock(
      'orders:rebuild',
      async held => {
        await new Promise(resolve => setTimeout(resolve, 5 * Second))
        lost = held.lost
      },
      { ttl: 1 * Second },
    )
    await vi.advanceTimersByTimeAsync(5 * Second)

    expect(await section).toEqual({ executed: true, result: undefined })
    expect(lost).toBe(false)
  })

  it('does not renew a manual acquisition unless asked', async () => {
    const lock = await newLock()
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 1 * Second })
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(held.lost).toBe(true)
    expect(await lock.tryAcquire('orders:rebuild')).not.toBeUndefined()
  })
})
