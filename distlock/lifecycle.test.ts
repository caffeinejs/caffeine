import { CaffeineIoC } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import { afterEach, describe, expect, it } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLock } from './distlock.js'
import { kDistLock } from './keys.js'
import { distlock } from './plugin.js'

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

  tryAcquire(key: string, ttlMs: number): Promise<LockLease | undefined> {
    return this.#inner.tryAcquire(key, ttlMs)
  }

  async extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined> {
    this.extensions += 1
    await sleep(50)

    const next = await this.#inner.extend(lease, ttlMs)
    this.settled += 1

    return next
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

async function newApp(backend: Backend): Promise<{ lock: DistLock; close: () => Promise<void> }> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).with(
    distlock(d => d.backend(backend)),
  )

  await app.ready()
  opened.push(() => app.close())

  return { lock: app.container.get(kDistLock), close: () => app.close() }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('distlock lifecycle', () => {
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

    await lock.once('nightly-report', () => 'done', { ttl: '1m' })
    await close()

    expect(await backend.tryAcquire('nightly-report', 1_000)).toBeUndefined()
  })
})
