import { createApplication } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC } from '@caffeinejs/di'
import { Day, Millisecond, Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend, RotatingBackend, StagedBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import { CaffeineDistLock, type DistLock } from './distlock.js'
import { ErrDistLockConfiguration, ErrInvalidLockKey, ErrLockBackendTimeout, ErrLockNotAcquired } from './errors.js'
import { kDistLock } from './keys.js'
import { RecordingLogger } from './log.testkit.js'
import type { AcquireContext } from './observability/channels.js'
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
    expect(await held.extend(next)).toBe(false)
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
    expect(await lengthening).toBe(order[0] === 'short')

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
    expect(held.lost).toBe(true)
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
      const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })

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
      const running = lock.once('orders:rebuild', () => action.promise, { renew: true })

      await vi.advanceTimersByTimeAsync(25 * Second)
      expect(backend.extensions).toBe(1)
      expect(losses).toEqual([expect.objectContaining({ reason: 'error', renewal: true })])
      expect(await lock.tryAcquire('orders:rebuild')).toBeUndefined()

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
      .acquire('orders:rebuild', { wait: 6 * Second, retryDelay: 2 * Second })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(6 * Second)

    expect(await acquiring).toBeInstanceOf(ErrLockBackendTimeout)
    expect(backend.attempts).toBe(1)
  })

  it('reports loss instead of success when renewal timed out before a rotation was confirmed', async () => {
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
    expect(await extending).toBe(false)
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

  it('renews a live rotation even if an older reply temporarily showed an expired lease', async () => {
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
    short!.answer()
    expect(await shortening).toBe(false)
    rotated!.answer()
    expect(await rotating).toBe(true)

    await vi.advanceTimersByTimeAsync(2 * Second)
    expect(backend.extends).toHaveLength(3)
    const renewal = backend.extends[2]!
    await renewal.write()
    renewal.answer()
    await vi.advanceTimersByTimeAsync(0)

    expect(held.expiresAt).toBe(Date.now() + 6 * Second)
    await held.release()
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

  it('can resume renewal after an explicit write replaces an expired conservative bound', async () => {
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

    const recovering = held.extend(30 * Second)
    const recovery = backend.extends[2]!
    await recovery.write()
    recovery.answer()
    expect(await recovering).toBe(true)

    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(backend.extends).toHaveLength(4)
    const renewal = backend.extends[3]!
    await renewal.write()
    renewal.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(held.expiresAt).toBe(Date.now() + 30 * Second)
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
