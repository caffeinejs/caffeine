import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Minute, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { FaultyBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import type { DistLock, Lock } from './distlock.js'
import { ErrLockLost } from './errors.js'
import { kDistLock } from './keys.js'
import { RecordingLogger } from './log.testkit.js'
import type { LostMessage } from './observability/channels.js'
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

/** Hands out a new token on every extend, as {@link Backend.extend} allows. */
class RotatingBackend implements Backend {
  readonly inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.inner.tryAcquire(key, ttl)
  }

  async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    if ((await this.inner.extend(lease, ttl)) === undefined) {
      return undefined
    }

    await this.inner.release(lease)
    return this.inner.tryAcquire(lease.key, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.inner.release(lease)
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

async function newApp(
  backend: Backend,
  configure?: (d: DistLockBuilder) => void,
): Promise<{ lock: DistLock; close: () => Promise<void> }> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
    DistributedLock(d => {
      d.backend(backend)
      configure?.(d)
    }),
  )

  await app.bootstrap()
  opened.push(() => app.close())

  return { lock: app.container.get(kDistLock), close: () => app.close() }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A promise the test resolves when it chooses, standing in for an action still running. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>(resolve => (open = resolve))
  return { promise, open }
}

/** Starts `close()`, and reports whether it has resolved yet. */
function closing(close: () => Promise<void>): { readonly done: boolean; promise: Promise<void> } {
  const state = { done: false, promise: close() }
  void state.promise.finally(() => (state.done = true)).catch(() => undefined)
  return state
}

describe('distlock shutdown', () => {
  // A replica restarting mid-job should let the job finish, and keep it covered while it does, before the key
  // goes to anyone else.
  it('waits for a withLock action to finish, up to drainTimeout, renewing it meanwhile, and releases its key once', async () => {
    const memory = new MemoryLockBackend()
    const backend = new FaultyBackend(memory)
    const { lock, close } = await newApp(backend, d => d.drainTimeout(5 * Second))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const job = latch()
    let held: Lock | undefined
    const running = lock.withLock(
      'orders:rebuild',
      async l => {
        held = l
        await job.promise
        return 'rebuilt'
      },
      { ttl: 3 * Second },
    )
    await vi.advanceTimersByTimeAsync(0)

    const shutdown = closing(close)
    // Past the lease the action started with: only renewal keeps it.
    await vi.advanceTimersByTimeAsync(4 * Second)

    expect(shutdown.done).toBe(false)
    expect(held?.signal.aborted).toBe(false)
    expect(await memory.tryAcquire('orders:rebuild', 1 * Minute)).toBeUndefined()

    job.open()
    await shutdown.promise

    expect(await running).toBe('rebuilt')
    expect(backend.released.map(lease => lease.key)).toEqual(['orders:rebuild'])
    expect(await memory.tryAcquire('orders:rebuild', 1 * Minute)).toBeDefined()
  })

  // An action that ignores its signal may still be writing: the key must not go to another replica before the
  // lease would have lapsed anyway.
  it('aborts a withLock action still running after drainTimeout with ErrLockLost(shutdown), and leaves its key held until it lapses', async () => {
    const memory = new MemoryLockBackend()
    const { lock, close } = await newApp(memory, d => d.drainTimeout(1 * Second))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    let held: Lock | undefined
    void lock
      .withLock(
        'orders:rebuild',
        l => {
          held = l
          return new Promise(() => undefined)
        },
        { ttl: 30 * Second },
      )
      .catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    const shutdown = closing(close)
    await vi.advanceTimersByTimeAsync(1 * Second)
    expect(held?.signal.aborted).toBe(true)

    await vi.advanceTimersByTimeAsync(5 * Second)
    expect(shutdown.done).toBe(true)

    const reason: unknown = held?.signal.reason
    expect(reason).toBeInstanceOf(ErrLockLost)
    expect((reason as ErrLockLost).reason).toBe('shutdown')
    expect(await memory.tryAcquire('orders:rebuild', 1 * Second)).toBeUndefined()

    await vi.advanceTimersByTimeAsync(held!.expiresAt - Date.now())
    expect(await memory.tryAcquire('orders:rebuild', 1 * Second)).toBeDefined()
  })

  // The rolling-restart case: the next replica gets the key as soon as this one stops using it, not a lease later.
  it('hands a key over when its holder releases on abort', async () => {
    const memory = new MemoryLockBackend()
    const { lock, close } = await newApp(memory)

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    held.signal.addEventListener('abort', () => void held.release())

    await close()

    expect(await memory.tryAcquire('orders:rebuild', 1 * Second)).toBeDefined()
  })

  // A release still on the wire when close resolves is a write the application no longer owns.
  it('waits for a release its holder started on abort before close resolves', async () => {
    const backend = new FaultyBackend()
    const { lock, close } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second })
    backend.late = ['release']
    held.signal.addEventListener('abort', () => void held.release())

    const shutdown = closing(close)
    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(backend.released.map(lease => lease.key)).toEqual(['orders:rebuild'])
    expect(shutdown.done).toBe(false)

    backend.answerLate()
    await shutdown.promise
  })

  // A window left standing is out of the holder's hands: shutdown has nothing to abort, and must not report it lost.
  it('does not report a once window lost when the application closes after its action returned', async () => {
    const { lock, close } = await newApp(new MemoryLockBackend())
    const lost: LostMessage[] = []
    lock.events.on('lost', message => lost.push(message))

    await lock.once('nightly-report', () => 'done', { ttl: 1 * Minute })
    await close()

    expect(lost).toEqual([])
  })

  it('closes within drainTimeout + storeTimeout when the backend never answers', async () => {
    const backend = new FaultyBackend()
    const { lock, close } = await newApp(backend, d => d.drainTimeout(2 * Second).storeTimeout(1 * Second))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    // One action that stops on abort and has to release, one that never stops, and a renewal on the wire.
    void lock
      .withLock('a', l => new Promise((_, reject) => l.signal.addEventListener('abort', () => reject(l.signal.reason))))
      .catch(() => undefined)
    void lock.withLock('b', () => new Promise(() => undefined)).catch(() => undefined)
    await lock.acquire('c', { ttl: 3 * Second, renew: true })
    await vi.advanceTimersByTimeAsync(0)
    for (const operation of ['acquire', 'extend', 'release'] as const) {
      backend.hang.add(operation)
    }
    await vi.advanceTimersByTimeAsync(1 * Second)

    const shutdown = closing(close)
    await vi.advanceTimersByTimeAsync(2 * Second + 1 * Second)

    expect(shutdown.done).toBe(true)
  })

  // A lease taken once the abort has passed would otherwise renew after close, through a backend being torn down.
  it('ends a lock acquired after the abort with ErrLockLost(shutdown), rather than renewing it past close', async () => {
    const { lock, close } = await newApp(new MemoryLockBackend(), d => d.drainTimeout(0))

    await close()
    const late = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })

    const reason: unknown = late.signal.reason
    expect(reason).toBeInstanceOf(ErrLockLost)
    expect((reason as ErrLockLost).reason).toBe('shutdown')
  })

  // A holder that stops and releases when told to has not outrun its lease: dashboards must not count every
  // deploy as a critical section that lapsed.
  it('does not report a section released on a shutdown abort as lapsed', async () => {
    const { lock, close } = await newApp(new MemoryLockBackend(), d => d.drainTimeout(0))
    const lapsed: Array<[string, boolean | undefined]> = []
    lock.events.on('withLock', ctx => lapsed.push(['withLock', ctx.lapsed]))
    lock.events.on('release', ctx => lapsed.push(['release', ctx.lapsed]))

    const started = latch()
    const section = lock
      .withLock('orders:rebuild', l => {
        started.open()
        return new Promise((_, reject) => l.signal.addEventListener('abort', () => reject(l.signal.reason)))
      })
      .catch(() => undefined)
    await started.promise

    await close()
    await section

    expect(lapsed).toEqual([
      ['release', false],
      ['withLock', false],
    ])
  })

  // Operators get one line for the shutdown; dashboards get one loss per lease.
  it('publishes one lost message per key ended by shutdown, and one warning for all of them', async () => {
    const log = new RecordingLogger()
    const { lock, close } = await newApp(new MemoryLockBackend(), d => d.logger(log).drainTimeout(0))
    const lost: LostMessage[] = []
    lock.events.on('lost', message => lost.push(message))

    await lock.acquire('a', { ttl: 1 * Minute })
    await lock.acquire('b', { ttl: 1 * Minute, renew: true })
    const released = await lock.acquire('c', { ttl: 1 * Minute })
    await released.release()

    await close()

    expect(lost.map(m => [m.key, m.reason]).sort()).toEqual([
      ['a', 'shutdown'],
      ['b', 'shutdown'],
    ])
    expect(log.at('warn').map(r => [r.msg, r.fields])).toEqual([
      ['lock service closed with locks still held', { count: 2 }],
    ])
  })
})

describe('distlock lifecycle', () => {
  // `await using` and an explicit release in the same scope both release: the second must not send a release that
  // could land after another replica took the key, nor hold up a shutdown waiting for it.
  it('sends one release to the backend when a lock is released twice', async () => {
    const backend = new FaultyBackend()
    const { lock } = await newApp(backend)

    const held = await lock.acquire('a', { ttl: 1 * Minute })
    await held.release()
    await held.release()

    expect(backend.released.map(lease => lease.key)).toEqual(['a'])
  })

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

  it('releases with the token a renewal rotated', async () => {
    const backend = new RotatingBackend()
    const { lock } = await newApp(backend)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const held = await lock.acquire('orders:rebuild', { ttl: 30 * Second, renew: true })
    const first: LockLease = { key: held.key, token: held.token, expiresAt: held.expiresAt }
    await vi.advanceTimersByTimeAsync(10 * Second)
    expect(held.token).not.toBe(first.token)

    await held.release()
    const successor = await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)
    expect(successor).toBeDefined()

    await backend.release(first)
    expect(await backend.inner.tryAcquire('orders:rebuild', 1 * Minute)).toBeUndefined()
  })
})
