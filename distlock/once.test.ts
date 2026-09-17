import { CaffeineIoC } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import { afterEach, describe, expect, it } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLock } from './distlock.js'
import { kDistLock } from './keys.js'
import { distlock } from './plugin.js'

/**
 * Counts renewals and takes real time answering them, so an action that ends while one is on the wire — the
 * case a cleared timer cannot reach — is reproducible.
 */
class SlowRenewalBackend implements Backend {
  extensions = 0
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
    await close()
  }
})

async function newLock(backend: Backend = new MemoryLockBackend()): Promise<DistLock> {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).with(
    distlock(d => d.backend(backend)),
  )

  await app.ready()
  opened.push(() => app.close())

  return app.container.get(kDistLock)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>(resolve => {
    open = resolve
  })

  return { wait, open }
}

describe('once', () => {
  // The loser must not be made to wait on the winner: it learns it lost while the winner is still working.
  it('hands the action to one caller and turns the other away immediately', async () => {
    const lock = await newLock()
    const started = gate()
    const finish = gate()

    const winner = lock.once(
      'nightly-report',
      async () => {
        started.open()
        await finish.wait
        return 'report'
      },
      { ttl: '1m' },
    )

    await started.wait
    const loser = await lock.once('nightly-report', () => 'never', { ttl: '1m' })

    expect(loser.executed).toBe(false)
    expect(loser.result).toBeUndefined()

    finish.open()
    await expect(winner).resolves.toEqual({ executed: true, result: 'report' })
  })

  // The window is the point of `once`: the key is *not* given back when the action succeeds, so a caller that
  // arrives afterwards is turned away just like a concurrent one. Adding a release to the success path breaks
  // this and nothing else.
  it('keeps turning callers away after the action already finished, until the window closes', async () => {
    const lock = await newLock()

    await expect(lock.once('nightly-report', () => 'first', { ttl: '1m' })).resolves.toEqual({
      executed: true,
      result: 'first',
    })

    await expect(lock.once('nightly-report', () => 'second', { ttl: '1m' })).resolves.toEqual({ executed: false })
  })

  it('runs again once the window has closed', async () => {
    const lock = await newLock()

    await lock.once('nightly-report', () => 'first', { ttl: 20 })
    await sleep(40)

    await expect(lock.once('nightly-report', () => 'second', { ttl: 20 })).resolves.toEqual({
      executed: true,
      result: 'second',
    })
  })

  // A window closed by a failure would keep every replica out of work that never actually happened.
  it('gives the key back when the action throws, so another caller may retry inside the window', async () => {
    const lock = await newLock()
    const boom = new Error('boom')

    await expect(lock.once('nightly-report', () => Promise.reject(boom), { ttl: '1m' })).rejects.toBe(boom)

    await expect(lock.once('nightly-report', () => 'retried', { ttl: '1m' })).resolves.toEqual({
      executed: true,
      result: 'retried',
    })
  })

  it('keeps the window shut after a failure when the caller asked it to', async () => {
    const lock = await newLock()
    const boom = new Error('boom')

    await expect(
      lock.once('nightly-report', () => Promise.reject(boom), { ttl: '1m', releaseOnError: false }),
    ).rejects.toBe(boom)

    await expect(lock.once('nightly-report', () => 'retried', { ttl: '1m' })).resolves.toEqual({ executed: false })
  })

  // Without renewal an action outliving its window reopens it underneath itself, and a second replica starts
  // the same work while the first is still doing it. These two cases are why `renew` exists.
  it('reopens the window under an action that outlives it when renewal is off', async () => {
    const lock = await newLock()

    await lock.once('nightly-report', () => sleep(90), { ttl: 40 })

    await expect(lock.once('nightly-report', () => 'second', { ttl: 40 })).resolves.toEqual({
      executed: true,
      result: 'second',
    })
  })

  it('holds the window across an action that outlives it when renewal is on', async () => {
    const lock = await newLock()

    await lock.once('nightly-report', () => sleep(90), { ttl: 40, renew: true })

    await expect(lock.once('nightly-report', () => 'second', { ttl: 40 })).resolves.toEqual({ executed: false })
  })

  // Renewal exists to hold the window open while the action runs, and it has to stop when the action is done
  // or the window never closes and the job never runs again. Stopping cannot be a cleared timer alone: the
  // action here ends while a renewal is already on the wire, and that renewal is the one that would arm the
  // next timer.
  it('stops renewing when the action ends mid-renewal, so the window still closes', async () => {
    const backend = new SlowRenewalBackend()
    const lock = await newLock(backend)

    // Renews at a third of the lease, so a renewal leaves at ~100ms and answers 50ms later; the action ends
    // at ~120ms, between the two.
    await lock.once('nightly-report', () => sleep(120), { ttl: 300, renew: true })

    // Precondition: the window was renewed, and that renewal is still unanswered. Without it this passes for
    // the wrong reason.
    expect(backend.extensions).toBe(1)
    expect(backend.settled).toBe(0)

    const renewed = backend.extensions
    await sleep(400)

    expect(backend.extensions).toBe(renewed)
    await expect(lock.once('nightly-report', () => 'second', { ttl: 300 })).resolves.toEqual({
      executed: true,
      result: 'second',
    })
  })

  // Two applications, one shared backend: the cross-replica claim reduced to a single process.
  it('runs the action on exactly one of two applications sharing a backend', async () => {
    const backend = new MemoryLockBackend()
    const one = await newLock(backend)
    const two = await newLock(backend)

    const results = await Promise.all([
      one.once('migrate', () => 'one', { ttl: '1m' }),
      two.once('migrate', () => 'two', { ttl: '1m' }),
    ])

    expect(results.filter(r => r.executed)).toHaveLength(1)
  })
})
