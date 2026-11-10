import { createApplication } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC } from '@caffeinejs/di'
import { Day, Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend, RotatingBackend, StagedBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import { CaffeineDistLock, type DistLock, type Lock } from './distlock.js'
import {
  ErrDistLockConfiguration,
  ErrInvalidLockKey,
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

  // The backend may have cut the lease to the shorter ttl before the call gave up on it. Until the answer says how
  // long the lease runs, a caller checking `lost` must not carry on as the holder: another replica may have the key.
  it('reads as lost while an extend that timed out has not answered, since it may have shortened the lease', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    const extending = held.extend(2 * Second).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)

    expect(held.lost).toBe(true)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('reads as held again once the extend that timed out answers with the lease', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['extend']
    const extending = held.extend(1 * Minute).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await extending
    expect(held.lost).toBe(true)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.lost).toBe(false)
  })

  // A backend may apply two extends under one token in either order. When one answers late after the other
  // succeeded, nothing says which landed last, so the lock goes by the expiry that ends sooner.
  it.each([
    { name: 'the late one is shorter', late: 10 * Second, next: 10 * Minute },
    { name: 'the late one is longer', late: 10 * Minute, next: 10 * Second },
  ])('keeps the earlier expiry of two extends under one token when $name', async ({ late, next }) => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const sentLate = Date.now()
    backend.late = ['extend']
    const stale = held.extend(late).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5 * Second)
    await stale

    backend.late = []
    const sentNext = Date.now()
    expect(await held.extend(next)).toBe(true)
    expect(held.lost).toBe(true)

    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.expiresAt).toBe(Math.min(sentLate + late, sentNext + next))
    expect(held.lost).toBe(false)
  })

  // Two extends under one token can land in one order and answer in the other. Here the shorter one lands last, so
  // the key runs out after it. Whichever order the answers come in, the lock must read as lost by the time another
  // replica can take the key.
  it.each([
    { name: 'the timed-out extend answers first', order: ['short', 'long'] as const },
    { name: 'the on-time extend answers first', order: ['long', 'short'] as const },
  ])('reads as lost when a shorter extend landed last and $name', async ({ order }) => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const shortening = held.extend(2 * Second).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await shortening).toBeInstanceOf(ErrLockBackendTimeout)

    const lengthening = held.extend(1 * Minute)
    const [short, long] = backend.extends
    await long!.write()
    await short!.write()
    for (const which of order) {
      ;(which === 'short' ? short : long)!.answer()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(await lengthening).toBe(true)

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
    expect(held.lost).toBe(true)
  })

  // A backend that cancels a command it had not sent yet rejects with the reason it was handed: the extend never
  // took effect, so the lease it was sent on still stands and renewal can go on.
  it('keeps the lease when an extend that timed out is cancelled before it reached the backend', async () => {
    const backend = new StagedBackend()
    backend.cancelsUnwritten = true
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const before = held.expiresAt
    const extending = held.extend(1 * Minute).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)

    expect(held.lost).toBe(false)
    expect(held.expiresAt).toBe(before)
  })

  // A backend that rotates the token refuses a call carrying an old one. That refusal says the old token is gone,
  // which a newer extend already knew: it is not news about the lease that extend moved the key to.
  it('keeps the lease a rotating extend moved the key to when an older extend is refused late', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const first = held.token
    const stale = held.extend(1 * Minute).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await stale).toBeInstanceOf(ErrLockBackendTimeout)

    const rotating = held.extend(1 * Minute)
    const [older, newer] = backend.extends
    await newer!.write()
    newer!.answer()
    expect(await rotating).toBe(true)

    await older!.write()
    older!.answer()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.token).not.toBe(first)
    expect(held.lost).toBe(false)
  })

  // The renewal that timed out already reported the loss. Whatever it answers afterwards is the same incident: a
  // second loss would double the alert, and a lease it never got has nothing to give back.
  it.each([
    {
      name: 'fails',
      fault: (inner: FaultyBackend) => {
        inner.failExtend = true
      },
    },
    {
      name: 'says the key was taken',
      fault: (inner: FaultyBackend) => {
        inner.stolen = true
      },
    },
  ])('reports one loss when a renewal that timed out later $name', async ({ fault }) => {
    const inner = new FaultyBackend()
    const backend = new FaultyBackend(inner)
    const lock = await newLock(backend)
    const losses: unknown[] = []
    lock.events.on('lost', message => losses.push(message))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    // Short enough that the first renewal to time out leaves no time for another: it gives the lease up.
    const held = await lock.acquire('orders:rebuild', { ttl: 12 * Second, renew: true })
    backend.late = ['extend']
    fault(inner)
    // The renewal leaves at a third of the lease and is abandoned at storeTimeout.
    await vi.advanceTimersByTimeAsync(9 * Second)
    expect(held.lost).toBe(true)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(losses).toEqual([expect.objectContaining({ reason: 'error', renewal: true })])
    expect(backend.released).toEqual([])
  })

  // An abort listener ahead of the lock's own may stop propagation; the caller still aborted, so the acquisition
  // must not hand over a key, and a lease that lands anyway goes back.
  it("rejects with the caller's reason when an earlier abort listener stops propagation, and gives back the late lease", async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    const controller = new AbortController()
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation())
    backend.late = ['acquire']

    const attempt = lock.tryAcquire('orders:rebuild', { signal: controller.signal }).catch((e: unknown) => e)
    controller.abort(new Error('caller gave up'))
    backend.late = []
    backend.answerLate()

    expect(await attempt).toEqual(new Error('caller gave up'))
    await vi.waitFor(() => expect(backend.released.map(lease => lease.key)).toEqual(['orders:rebuild']))
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
  it('gives nothing back, and reads as lost, when an extend answers late that the key was taken', async () => {
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
    expect(held.lost).toBe(true)
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

  // The builder refuses it while the feature configures; a service built without the builder needs the same
  // guard, or Node turns the delay into 1 ms and every release times out claiming it waited the whole span.
  it('refuses a store timeout longer than a timer can wait when constructed directly', () => {
    expect(
      () =>
        new CaffeineDistLock(
          new MemoryLockBackend(),
          { ...DEFAULT_DIST_LOCK_OPTIONS, storeTimeout: 30 * Day },
          newNoopLogger(),
        ),
    ).toThrow(ErrDistLockConfiguration)
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
