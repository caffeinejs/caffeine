import { createApplication } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC } from '@caffeinejs/di'
import { Day, Millisecond, Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend, RotatingBackend, StagedBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import { CaffeineDistLock, type AcquireOptions, type DistLock, type Lock } from './distlock.js'
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
import type { AcquireContext, LostMessage } from './observability/channels.js'
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

class ConditionallyRotatingBackend extends RotatingBackend {
  keptTTL = 1 * Minute

  override extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    return ttl === this.keptTTL ? this.inner.extend(lease, ttl) : super.extend(lease, ttl)
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
    expect(await held.extend(10 * Minute)).toBe(false)
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

    // The work bound to the signal stops when the shorter lease could end, not at the old expiry 28s later.
    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(held.signal.reason).toBeInstanceOf(ErrLockLost)
    const reason: unknown = held.signal.reason

    await vi.advanceTimersByTimeAsync(3 * Second)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)

    expect(held.lost).toBe(true)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()

    // An answer arriving now does not hand the holder back a lease another replica already took.
    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)
    expect(held.lost).toBe(true)
    expect(held.signal.reason).toBe(reason)
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
    expect(await held.extend(next)).toBe(false)
    expect(held.lost).toBe(true)

    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.expiresAt).toBe(Math.min(sentLate + late, sentNext + next))
    expect(held.lost).toBe(false)
  })

  // Two extends under one token can land in one order and answer in the other. Here the shorter one lands last, so
  // the key runs out after it. The lock must read as lost, and its signal abort, by the time another replica can
  // take the key, and whichever order the answers come in after that, the loss stands.
  it.each([
    { name: 'the shorter extend answers first', order: ['short', 'long'] as const },
    { name: 'the longer extend answers first', order: ['long', 'short'] as const },
  ])('reads as lost when a shorter extend landed last and $name', async ({ order }) => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const shortening = held.extend(2 * Second)
    const lengthening = held.extend(1 * Minute)
    const [short, long] = backend.extends
    await long!.write()
    await short!.write()

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
    expect(held.lost).toBe(true)
    const reason: unknown = held.signal.reason
    expect(reason).toBeInstanceOf(ErrLockLost)

    for (const which of order) {
      ;(which === 'short' ? short : long)!.answer()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(await shortening).toBe(false)
    expect(await lengthening).toBe(false)
    expect(held.lost).toBe(true)
    expect(held.signal.reason).toBe(reason)
  })

  it('does not forget an overlapping write when its expiry leaves the current cap unchanged', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild')
    const first = held.extend(10 * Second)
    const delayed = held.extend(10 * Second).catch((error: unknown) => error)
    const [firstWrite, delayedWrite] = backend.extends
    await firstWrite!.write()
    firstWrite!.answer()
    expect(await first).toBe(false)
    expect(held.lost).toBe(true)

    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await delayed).toBeInstanceOf(ErrLockBackendTimeout)

    const last = held.extend(1 * Minute)
    const lastWrite = backend.extends[2]!
    await lastWrite.write()
    await delayedWrite!.write()
    delayedWrite!.answer()
    await vi.advanceTimersByTimeAsync(0)
    lastWrite.answer()
    expect(await last).toBe(true)

    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    expect(held.lost).toBe(true)
  })

  it('releases a rotated token even after an earlier same-token reply changed the lease', async () => {
    const backend = new StagedBackend(new ConditionallyRotatingBackend())
    const lock = await newLock(backend)
    const held = await lock.acquire('orders:rebuild')
    const originalToken = held.token

    const keeping = held.extend(1 * Minute)
    const rotating = held.extend(30 * Second)
    const [keep, rotate] = backend.extends
    await keep!.write()
    keep!.answer()
    expect(await keeping).toBe(true)
    await rotate!.write()
    rotate!.answer()
    expect(await rotating).toBe(true)

    expect(held.token).not.toBe(originalToken)
    await held.release()
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('keeps the current lease when a timed-out extension rejects under its old token', async () => {
    const inner = new FaultyBackend(new RotatingBackend())
    const backend = new StagedBackend(inner)
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild')
    const delayed = held.extend(10 * Second).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(await delayed).toBeInstanceOf(ErrLockBackendTimeout)

    const rotating = held.extend(1 * Minute)
    const [old, rotate] = backend.extends
    await rotate!.write()
    rotate!.answer()
    expect(await rotating).toBe(true)

    inner.failExtend = true
    await expect(old!.write()).rejects.toThrow('backend down')
    old!.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(held.lost).toBe(false)
  })

  it('reads as lost before a late renewal frees the key', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const lostAtRelease: boolean[] = []
      const backend = new (class extends MemoryLockBackend {
        override extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
          now += 6 * Second
          return super.extend(lease, ttl)
        }

        override release(lease: LockLease): Promise<void> {
          lostAtRelease.push(held.lost)
          return super.release(lease)
        }
      })()
      const lock = await newLock(backend)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      // Short enough that the renewal, sent with 4s left, has no time to retry and gives its late answer back.
      const held = await lock.acquire('orders:rebuild', { ttl: 6 * Second, renew: true })

      await vi.advanceTimersByTimeAsync(10 * Second)
      expect(lostAtRelease).toEqual([true])
      expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    } finally {
      clock.mockRestore()
    }
  })

  it('reports the winning backend error if the caller aborts before its handler runs', async () => {
    const error = new Error('backend failed first')
    const backend = new (class extends MemoryLockBackend {
      override tryAcquire(): Promise<LockLease | undefined> {
        throw error
      }
    })()
    const lock = await newLock(backend)
    const outcomes: AcquireContext[] = []
    lock.events.on('acquire', outcome => outcomes.push(outcome))

    const controller = new AbortController()
    const acquiring = lock.tryAcquire('orders:rebuild', { signal: controller.signal })
    queueMicrotask(() => controller.abort(new Error('caller stopped later')))

    await expect(acquiring).rejects.toBe(error)
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'error', failures: { timeout: 0, other: 1 } })])
  })

  it('releases the token from an explicit extension already on the wire', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    const held = await lock.acquire('orders:rebuild')
    const extending = held.extend(1 * Minute)
    const write = backend.extends[0]!
    await write.write()

    const releasing = held.release()
    await Promise.resolve()
    write.answer()
    expect(await extending).toBe(true)
    await releasing

    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('keeps a rotated lease when an old-token refusal arrives first', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    const losses: unknown[] = []
    lock.events.on('lost', loss => losses.push(loss))
    const held = await lock.acquire('orders:rebuild')

    const rotating = held.extend(1 * Minute)
    const refused = held.extend(1 * Minute)
    const [rotate, old] = backend.extends
    await rotate!.write()
    await old!.write()
    old!.answer()
    expect(await refused).toBe(false)

    rotate!.answer()
    expect(await rotating).toBe(true)
    expect(held.lost).toBe(false)
    expect(losses).toEqual([])
  })

  it('refuses a shortened extension whose lease already expired before the reply', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild')
    const extending = held.extend(1 * Second)
    const write = backend.extends[0]!
    await write.write()
    await vi.advanceTimersByTimeAsync(1 * Second)
    write.answer()

    expect(await extending).toBe(false)
    expect(held.lost).toBe(true)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('preserves a timed-out once window without restarting renewal after a late rotation', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const action = Promise.withResolvers<void>()
    try {
      const backend = new (class extends RotatingBackend {
        extensions = 0

        override extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
          this.extensions += 1
          now += 6 * Second
          return super.extend(lease, ttl)
        }
      })()
      const lock = await newLock(backend)
      const losses: unknown[] = []
      lock.events.on('lost', loss => losses.push(loss))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      // Short enough that the renewal, sent with 4s left, has no time to retry: the lease is lost, and the late
      // rotation it brings is the window's to keep.
      const running = lock.once('orders:rebuild', () => action.promise, { renew: true, ttl: 6 * Second })

      await vi.advanceTimersByTimeAsync(3 * Second)
      expect(backend.extensions).toBe(1)
      expect(losses).toEqual([expect.objectContaining({ reason: 'error', renewal: true })])
      expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()

      await vi.advanceTimersByTimeAsync(22 * Second)
      expect(backend.extensions).toBe(1)

      action.resolve()
      await running
    } finally {
      action.resolve()
      clock.mockRestore()
    }
  })

  it('moves the renewal timer forward when an explicit extension shortens the lease', async () => {
    const lock = await newLock()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })

    expect(await held.extend(3 * Second)).toBe(true)
    await vi.advanceTimersByTimeAsync(4 * Second)

    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    expect(held.lost).toBe(false)
    await held.release()
  })

  it('preserves the last store timeout when backoff uses the remaining wait budget', async () => {
    const backend = new FirstAttemptHangsBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const acquiring = lock
      .acquire('orders:rebuild', { wait: 6 * Second, retryDelay: 2 * Second, maxRetryDelay: 2 * Second })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(6 * Second)

    expect(await acquiring).toBeInstanceOf(ErrLockBackendTimeout)
    expect(backend.attempts).toBe(1)
  })

  // A renewal that timed out with time left retries. A rotation confirmed meanwhile supersedes the write the renewal
  // may have made under the old token, so the lock holds the new lease rather than reporting it lost.
  it('keeps the lease a rotation confirmed after a renewal timed out with time to retry', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild', { renew: true })

    await vi.advanceTimersByTimeAsync(11 * Second)
    const extending = held.extend(1 * Minute)
    const rotate = backend.extends[1]!
    await rotate.write()
    await vi.advanceTimersByTimeAsync(4 * Second)
    expect(held.lost).toBe(true)

    rotate.answer()
    expect(await extending).toBe(true)
    expect(held.lost).toBe(false)
    expect(held.signal.aborted).toBe(false)
    await held.release()
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('publishes a single loss when a renewal failure settles a deferred refusal', async () => {
    const inner = new FaultyBackend()
    const backend = new StagedBackend(inner)
    const lock = await newLock(backend)
    const losses: unknown[] = []
    lock.events.on('lost', loss => losses.push(loss))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild', { renew: true })

    await vi.advanceTimersByTimeAsync(10 * Second)
    inner.stolen = true
    const extending = held.extend(1 * Minute)
    const [renew, refuse] = backend.extends
    await refuse!.write()
    refuse!.answer()
    expect(await extending).toBe(false)

    inner.failExtend = true
    await expect(renew!.write()).rejects.toThrow('backend down')
    renew!.answer()
    await vi.advanceTimersByTimeAsync(0)

    expect(losses).toEqual([expect.objectContaining({ reason: 'taken', renewal: false })])
  })

  it('does not advertise ownership while an unanswered extension can shorten it', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild')
    const extending = held.extend(1 * Second).catch((error: unknown) => error)
    const shorten = backend.extends[0]!
    await shorten.write()
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    expect(held.lost).toBe(true)
    shorten.answer()
    expect(await extending).toBe(false)
  })

  it('discards an earlier expiry once every possible latest write supersedes it', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild')
    const started = Date.now()

    const short = held.extend(10 * Second)
    const concurrent = held.extend(1 * Minute)
    const [shortWrite, concurrentWrite] = backend.extends
    await shortWrite!.write()
    shortWrite!.answer()
    expect(await short).toBe(true)

    const last = held.extend(1 * Minute)
    const lastWrite = backend.extends[2]!
    await concurrentWrite!.write()
    concurrentWrite!.answer()
    expect(await concurrent).toBe(true)
    await lastWrite.write()
    lastWrite.answer()
    expect(await last).toBe(true)

    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    expect(held.expiresAt).toBe(started + 1 * Minute)
    expect(held.lost).toBe(false)
  })

  it('reports loss if the current rotated lease expired before an older successful reply', async () => {
    const backend = new StagedBackend(new ConditionallyRotatingBackend())
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild')

    const older = held.extend(1 * Minute).catch((error: unknown) => error)
    const newer = held.extend(1 * Second)
    const [old, rotated] = backend.extends
    await old!.write()
    await rotated!.write()
    rotated!.answer()
    expect(await newer).toBe(true)

    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    old!.answer()
    expect(await older).toBe(false)
  })

  // Until the shortening extend answers, nothing says the rotation landed after it: the key may be free once its
  // ttl runs out. The signal aborts then, and answers arriving afterwards cannot hand the holder its lease back.
  it('stays lost once an unanswered shortening extend could have let the key go, whatever answers later', async () => {
    const inner = new ConditionallyRotatingBackend()
    inner.keptTTL = 1 * Second
    const backend = new StagedBackend(inner)
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild', { renew: true })

    const shortening = held.extend(1 * Second)
    const rotating = held.extend(6 * Second)
    const [short, rotated] = backend.extends
    await short!.write()
    await rotated!.write()
    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(held.signal.reason).toBeInstanceOf(ErrLockLost)
    short!.answer()
    expect(await shortening).toBe(false)
    rotated!.answer()
    expect(await rotating).toBe(false)

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(backend.extends).toHaveLength(2)
    expect(held.lost).toBe(true)
    await held.release()
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('waits for a rotating renewal when the backend starts release synchronously', async () => {
    const reply = Promise.withResolvers<void>()
    const written = Promise.withResolvers<void>()
    let releasing: Promise<void> | undefined
    const backend = new (class extends RotatingBackend {
      override extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
        const writing = super.extend(lease, ttl).then(async next => {
          written.resolve()
          await reply.promise
          return next
        })
        releasing = held.release()
        return writing
      }
    })()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild', { renew: true })

    await vi.advanceTimersByTimeAsync(10 * Second)
    await written.promise
    reply.resolve()
    expect(releasing).toBeDefined()
    await releasing
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
  })

  it('does not report success while an unanswered shortening may have freed the key', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild')

    const lengthening = held.extend(1 * Minute)
    const shortening = held.extend(1 * Second).catch((error: unknown) => error)
    const [long, short] = backend.extends
    await long!.write()
    await short!.write()
    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()

    long!.answer()
    expect(await lengthening).toBe(false)
    short!.answer()
    expect(await shortening).toBe(false)
  })

  it('does not resume renewal once the lease read as lost by its conservative bound', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const held = await lock.acquire('orders:rebuild', { renew: true })

    const shortening = held.extend(1 * Second)
    const lengthening = held.extend(1 * Minute)
    const [short, long] = backend.extends
    await short!.write()
    await long!.write()
    await vi.advanceTimersByTimeAsync(1 * Second)
    long!.answer()
    await lengthening
    short!.answer()
    expect(await shortening).toBe(false)
    expect(held.lost).toBe(true)

    expect(await held.extend(30 * Second)).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(backend.extends).toHaveLength(2)
    expect(held.signal.reason).toBeInstanceOf(ErrLockLost)
    await held.release()
  })

  it('reads as lost when an overlapping store deadline passed before timer delivery', async () => {
    let monotonic = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    try {
      const backend = new StagedBackend()
      const lock = await newLock(backend)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const started = Date.now()
      const held = await lock.acquire('orders:rebuild', { ttl: 100 * Millisecond })

      const delayed = held.extend(200 * Millisecond).catch((error: unknown) => error)
      const lengthening = held.extend(1 * Minute)
      const [short, long] = backend.extends
      await long!.write()
      long!.answer()
      expect(await lengthening).toBe(true)
      await short!.write()

      // Advancing these clocks without dispatching timers models a callback blocking the overdue deadline.
      monotonic = 200
      vi.setSystemTime(started + 200 * Millisecond)
      expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
      expect(held.lost).toBe(true)

      short!.answer()
      expect(await delayed).toBeInstanceOf(ErrLockBackendTimeout)
    } finally {
      clock.mockRestore()
    }
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

  // The key may change hands as soon as the release lands, which can be long before its answer arrives: work bound
  // to the signal stops when the holder lets go, not when the backend confirms it.
  it.each([
    { name: 'before the release reaches the backend', deletes: false },
    { name: 'when the backend deleted the key but has not answered', deletes: true },
  ])('aborts lock.signal with ErrLockReleased $name', async ({ deletes }) => {
    const answer = Promise.withResolvers<void>()
    const backend = new (class extends MemoryLockBackend {
      override async release(lease: LockLease): Promise<void> {
        if (deletes) {
          await super.release(lease)
        }
        await answer.promise
      }
    })()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 1 * Second })
    const releasing = held.release()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.signal.reason).toBeInstanceOf(ErrLockReleased)
    expect((await lock.tryAcquire('orders:rebuild')) !== undefined).toBe(deletes)

    // A release still unanswered when the lease runs out leaves the reason the holder let go with.
    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(held.signal.reason).toBeInstanceOf(ErrLockReleased)
    answer.resolve()
    await releasing
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

  // The renewal left under a token an explicit extend has since rotated away from. Its timing out says nothing about
  // the new lease, even one too short for the renewal to retry on.
  it('reports no loss when a renewal under a rotated-away token times out with no time left to retry', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 6 * Second, renew: true })
    // The renewal leaves at 2s with 4s left, and is given up on at 6s.
    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(backend.extends).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1 * Second)
    const rotating = held.extend(6 * Second)
    const rotation = backend.extends[1]!
    await rotation.write()
    rotation.answer()
    expect(await rotating).toBe(true)

    // At 6s the new lease has 3s left, under storeTimeout: a renewal of it would give up rather than retry.
    await vi.advanceTimersByTimeAsync(3 * Second)
    expect(held.lost).toBe(false)
    expect(held.signal.aborted).toBe(false)
    await held.release()
  })

  // The retry still carries the token the first renewal rotated away from, so the backend refuses it. That refusal
  // says nothing about the lease the first renewal moved the key to, which the lock adopts and keeps renewing.
  it('keeps the rotated lease when a retry under the old token is refused after the first renewal answered late', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    const losses: LostMessage[] = []
    lock.events.on('lost', message => losses.push(message))
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    // The renewal leaves at 10s and rotates the token, but its answer is held past the 15s timeout.
    await vi.advanceTimersByTimeAsync(10 * Second)
    const [rotating] = backend.extends
    await rotating!.write()
    await vi.advanceTimersByTimeAsync(5 * Second)

    // The retry leaves under the old token and is refused; the first answer lands before the refusal does.
    await vi.advanceTimersByTimeAsync(DEFAULT_DIST_LOCK_OPTIONS.retryDelay)
    expect(backend.extends).toHaveLength(2)
    const retry = backend.extends[1]!
    await retry.write()
    rotating!.answer()
    await vi.advanceTimersByTimeAsync(0)
    retry.answer()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.lost).toBe(false)
    expect(held.signal.aborted).toBe(false)
    expect(losses).toEqual([])

    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(backend.extends).toHaveLength(3)
    const next = backend.extends[2]!
    await next.write()
    next.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(held.expiresAt).toBe(Date.now() + 30 * Second)
    expect(held.lost).toBe(false)
    await held.release()
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
      { ttl: 30 * Day },
    )
    await vi.advanceTimersByTimeAsync(25 * Day)

    expect(aborted).toBe(false)
    expect(lost).toEqual([])
    expect(await lock.tryAcquire('yearly-report')).toBeUndefined()
  })

  // Each unanswered write may still land and set the key's expiry to its own ttl. One that looked longer when it left
  // can end up shorter than a reply that answered first, and the key may change hands from then on.
  it('aborts lock.signal when an unanswered extend could end the lease before the longer one that answered', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 3 * Second })
    const shorter = held.extend(4 * Second).catch((e: unknown) => e)
    const longer = held.extend(30 * Second)
    const [first, second] = backend.extends
    await second!.write()
    second!.answer()
    expect(await longer).toBe(true)
    await first!.write()

    await vi.advanceTimersByTimeAsync(4 * Second)
    expect(await shorter).toBeInstanceOf(ErrLockBackendTimeout)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    expect(lossOf(held).reason).toBe('expired')
  })

  // A write asking for as long as the one behind the lease only pushes the expiry out, however late it lands: a renewal
  // that never answered does not cut short the lease its retry renewed.
  it('keeps lock.signal live past the expiry a renewal that never answered could have set', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    // The renewal leaves at 10s and never answers; its retry and every renewal after it do.
    for (let elapsed = 0; elapsed < 41; elapsed += 1) {
      await vi.advanceTimersByTimeAsync(1 * Second)
      for (const call of backend.extends.slice(1)) {
        await call.write()
        call.answer()
      }
      backend.extends.splice(1)
    }

    expect(held.signal.aborted).toBe(false)
    expect(held.expiresAt).toBeGreaterThan(Date.now())
  })

  // A reply that reaches the lock after its own expiry says the write landed before the renewals that answered since:
  // the backend set that expiry from when it applied the write. It does not end a lease they carried on.
  it('keeps lock.signal live when a renewal applied before its retry answers after its own expiry', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    // The renewal leaves and lands at 10s but answers only at 41s; its retry and every renewal after it answer at once.
    await vi.advanceTimersByTimeAsync(10 * Second)
    const first = backend.extends.shift()!
    await first.write()
    for (let elapsed = 10; elapsed < 41; elapsed += 1) {
      await vi.advanceTimersByTimeAsync(1 * Second)
      for (const call of backend.extends.splice(0)) {
        await call.write()
        call.answer()
      }
    }

    first.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(held.signal.aborted).toBe(false)
    expect(held.lost).toBe(false)
  })

  // The `lost` event and the signal describe one incident: a listener cleaning up must not rename it a release.
  it('keeps the loss reason on lock.signal when a lost listener releases the lock', async () => {
    const lock = await newLock()
    let held: Lock | undefined
    let releasing: Promise<void> | undefined
    lock.events.on('lost', () => {
      releasing = held!.release()
    })
    fake()

    held = await lock.acquire('orders:rebuild', { ttl: 1 * Second })
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(lossOf(held).reason).toBe('expired')
    await releasing
  })

  // A callback that blocks the event loop past the expiry returns before the overdue deadline timer runs. The lease
  // still ran out while the action held it, so the holder learns it was lost, not that it let go.
  it.each([
    {
      name: 'withLock',
      run: (lock: DistLock, act: (held: Lock) => void) => lock.withLock('orders:rebuild', act, { ttl: 1 * Second }),
    },
    {
      name: 'once',
      run: (lock: DistLock, act: (held: Lock) => void) => lock.once('orders:rebuild', act, { ttl: 1 * Second }),
    },
  ])('reports a lease that ran out inside a blocking $name action as lost', async ({ run }) => {
    const lock = await newLock()
    const lost: LostMessage[] = []
    lock.events.on('lost', message => lost.push(message))
    fake()

    let seen: Lock | undefined
    await run(lock, held => {
      seen = held
      vi.setSystemTime(Date.now() + 2 * Second)
    })

    expect(lossOf(seen!).reason).toBe('expired')
    expect(lost).toEqual([expect.objectContaining({ key: 'orders:rebuild', reason: 'expired' })])
  })

  // The first renewal decided to retry, then its rotation answered: that answer is the lease, whatever the retry
  // under the old token does afterwards.
  it('adopts a late rotating renewal while its retry is pending, and survives the retry timing out', async () => {
    const backend = new StagedBackend(new RotatingBackend())
    const lock = await newLock(backend)
    const losses: LostMessage[] = []
    lock.events.on('lost', message => losses.push(message))
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 18 * Second, renew: true })
    const first = held.token
    // The renewal leaves at 6s and rotates the key to a lease valid until 24s; its answer is held past 11s.
    await vi.advanceTimersByTimeAsync(6 * Second)
    const [rotating] = backend.extends
    await rotating!.write()
    await vi.advanceTimersByTimeAsync(5 * Second)

    // The retry leaves under the old token at 11.1s and never answers.
    await vi.advanceTimersByTimeAsync(DEFAULT_DIST_LOCK_OPTIONS.retryDelay)
    expect(backend.extends).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(900 * Millisecond)
    rotating!.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(held.token).not.toBe(first)
    expect(held.lost).toBe(false)

    // The retry times out at 16.1s with under storeTimeout left on the old lease, which is no longer the lock's.
    await vi.advanceTimersByTimeAsync(4200 * Millisecond)
    expect(held.signal.aborted).toBe(false)
    expect(losses).toEqual([])
    expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()
    await held.release()
  })

  // Nothing else could have rotated the token, so a late refusal of it is the backend saying the key is gone.
  it('reports the key taken when a renewal that timed out with time to retry is refused late', async () => {
    const backend = new FaultyBackend()
    const lock = await newLock(backend)
    const losses: LostMessage[] = []
    lock.events.on('lost', message => losses.push(message))
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    backend.late = ['extend']
    backend.stolen = true
    // The renewal leaves at 10s and is given up on at 15s with 15s left: the retry would leave at 15.1s.
    await vi.advanceTimersByTimeAsync(15 * Second)
    expect(held.signal.aborted).toBe(false)

    backend.late = []
    backend.answerLate()
    await vi.advanceTimersByTimeAsync(0)

    expect(lossOf(held).reason).toBe('taken')
    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(losses).toEqual([expect.objectContaining({ reason: 'taken', renewal: true })])
  })

  // What is left of the lease is the window. A handle the action kept must not end or reshape it afterwards.
  it('ignores release and extend on a once lock after its action returned', async () => {
    const lock = await newLock()
    fake()

    const first = await lock.once('nightly-report', held => held, { ttl: 10 * Second })
    if (!first.executed) {
      throw new Error('the first once did not run')
    }

    await first.result.release()
    expect(await first.result.extend(1 * Second)).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(await lock.once('nightly-report', () => 'again')).toEqual({ executed: false })

    await vi.advanceTimersByTimeAsync(8 * Second)
    expect(await lock.once('nightly-report', () => 'again')).toEqual({ executed: true, result: 'again' })
  })

  // A backend that loses its connection may have applied the write before it could answer. Until something shows the
  // write had no effect, the shorter ttl it carried may be what the key now runs on.
  it('aborts lock.signal by the time a shorter extend that failed after it was applied could free the key', async () => {
    const fail = Promise.withResolvers<void>()
    const backend = new (class extends MemoryLockBackend {
      override async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
        await super.extend(lease, ttl)
        await fail.promise
        throw new Error('connection closed')
      }
    })()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const shortening = held.extend(1 * Second).catch((e: unknown) => e)
    fail.resolve()
    expect(await shortening).toBeInstanceOf(Error)

    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    expect(lossOf(held).reason).toBe('expired')
  })

  // Each failed write bounds the lease on its own: an earlier one that asked for longer does not stand in for it.
  it('aborts lock.signal at the shortest ttl among extends that failed after they were applied', async () => {
    const backend = new (class extends MemoryLockBackend {
      override async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
        await super.extend(lease, ttl)
        throw new Error('connection closed')
      }
    })()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    expect(await held.extend(20 * Second).catch((e: unknown) => e)).toBeInstanceOf(Error)
    expect(await held.extend(1 * Second).catch((e: unknown) => e)).toBeInstanceOf(Error)

    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(lossOf(held).reason).toBe('expired')
  })

  // A failed write gives no order on the backend: a write sent after it can land before it. A bound kept for one failed
  // write stands in for another only while nothing can take it away, so the answer of a longer write that landed
  // between them must not free the later one.
  it('aborts lock.signal by the expiry of a failed shorter extend that landed after a longer one answered last', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const a = held.extend(1 * Second).catch((e: unknown) => e)
    await backend.extends[0]!.write()
    backend.extends[0]!.fail(new Error('connection closed'))
    expect(await a).toBeInstanceOf(Error)

    const b = held.extend(30 * Second).catch((e: unknown) => e)
    await backend.extends[1]!.write()
    vi.setSystemTime(Date.now() + 500 * Millisecond)
    const c = held.extend(2 * Second).catch((e: unknown) => e)
    await backend.extends[2]!.write()
    backend.extends[2]!.fail(new Error('connection closed'))
    expect(await c).toBeInstanceOf(Error)
    backend.extends[1]!.answer()
    await b

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    expect(lossOf(held).reason).toBe('expired')
  })

  // A blocked event loop can let an extend's answer through before the overdue deadline timer. The lease ran out first,
  // and nothing answering afterwards revives it.
  it.each([
    { name: 'on time', late: false },
    { name: 'late', late: true },
  ])('keeps a lease lost whose deadline passed before an extend answered $name', async ({ late }) => {
    let monotonic = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    try {
      const backend = new StagedBackend()
      const lock = await newLock(backend)
      fake()

      const held = await lock.acquire('orders:rebuild', { ttl: 3 * Second })
      const extending = held.extend(30 * Second).catch((e: unknown) => e)
      const [call] = backend.extends
      await call!.write()

      // Advancing these clocks without dispatching timers models a callback blocking the overdue deadline.
      vi.setSystemTime(Date.now() + 4 * Second)
      if (late) {
        monotonic += 4 * Second
      }
      call!.answer()
      await extending
      await vi.advanceTimersByTimeAsync(0)

      expect(held.lost).toBe(true)
      expect(lossOf(held).reason).toBe('expired')
    } finally {
      clock.mockRestore()
    }
  })

  it('releases once when a lost listener releases from inside a release that found the deadline overdue', async () => {
    const backend = new CountingBackend()
    const lock = await newLock(backend)
    let held: Lock | undefined
    let inner: Promise<void> | undefined
    lock.events.on('lost', () => {
      inner = held!.release()
    })
    fake()

    held = await lock.acquire('orders:rebuild', { ttl: 1 * Second })
    vi.setSystemTime(Date.now() + 2 * Second)
    await held.release()
    await inner

    expect(lossOf(held).reason).toBe('expired')
    expect(backend.releases).toBe(1)
  })

  // A callback holding the event loop past a bound a failed write left keeps the deadline timer from firing. A
  // contender can take the key by then, so the holder must already read as lost and send nothing on it.
  it('reports the lock lost and sends no extend once a failed shorter extend could have freed the key', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const shortening = held.extend(1 * Second).catch((e: unknown) => e)
    await backend.extends[0]!.write()
    backend.extends[0]!.fail(new Error('connection closed'))
    expect(await shortening).toBeInstanceOf(Error)

    vi.setSystemTime(Date.now() + 2 * Second)
    expect(await lock.tryAcquire('orders:rebuild')).toBeDefined()
    expect(held.lost).toBe(true)
    expect(await held.extend(30 * Second)).toBe(false)
    expect(backend.extends).toHaveLength(1)
    expect(lossOf(held).reason).toBe('expired')
  })

  // A timer fires no earlier than asked, but one asked for a fraction of a millisecond is cut to the whole one below.
  it('keeps lock.signal live until a fractional ttl has fully run out', async () => {
    const lock = await newLock()
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 100.75 })
    await vi.advanceTimersByTimeAsync(100)
    expect(held.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(lossOf(held).reason).toBe('expired')
  })

  // An explicit extend that fails after it may have landed loses the lease too: the message must not blame a renewal
  // the holder never turned on.
  it('names an extension, not a renewal, when an explicit extend fails with its outcome unknown', async () => {
    const backend = new StagedBackend()
    const lock = await newLock(backend)
    fake()

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    const extending = held.extend(30 * Second).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(DEFAULT_DIST_LOCK_OPTIONS.storeTimeout)
    expect(await extending).toBeInstanceOf(ErrLockBackendTimeout)
    await backend.extends[0]!.write()
    backend.extends[0]!.fail(new Error('connection closed'))
    await vi.advanceTimersByTimeAsync(0)

    const loss = lossOf(held)
    expect(loss.reason).toBe('error')
    expect(loss.message.split('\n')[0]).toBe(
      'Cannot keep the lock on "orders:rebuild": an extension could not reach the backend',
    )
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
