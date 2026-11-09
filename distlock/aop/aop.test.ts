import { createApplication, ErrFeatureAlreadyInstalled, ErrFeatureNotInstalled } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Hour, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryLockBackend } from '../backend/memory/index.js'
import { ErrDistLockConfiguration, ErrInvalidLockKey } from '../errors.js'
import { DistributedLock } from '../plugin.js'
import { DistLockAOP } from './aop.js'
import { LeaderOnly } from './leader_only.js'
import { Once } from './once.js'
import { OneAtATime } from './one_at_a_time.js'

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

interface Options {
  lock?: boolean
  aop?: boolean
}

// One replica: an application with the given classes bound, decorators off so nothing registers anywhere else.
async function replica(backend: MemoryLockBackend, classes: Array<new () => object>, options: Options = {}) {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
  if (options.lock !== false) {
    app.install(
      DistributedLock(d =>
        d
          .backend(backend)
          .retryDelay(100 * Millisecond)
          .maxRetryDelay(100 * Millisecond)
          .retryJitter(0),
      ),
    )
  }
  if (options.aop !== false) {
    app.install(DistLockAOP())
  }
  for (const cls of classes) {
    app.container.bind(cls, t => t.toSelf())
  }
  opened.push(() => app.close())
  await app.bootstrap()

  return app
}

// A call that runs until the test releases it, and says when it started.
function latch() {
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const running = new Promise<void>(resolve => (started = resolve))
  return { held, running, release, started }
}

describe('@OneAtATime', () => {
  it('skips a call while another is running under the same key, and runs again once it finished', async () => {
    const gate = latch()
    let runs = 0
    class Sync {
      @OneAtATime('catalog:sync')
      async run(): Promise<string | undefined> {
        runs += 1
        gate.started()
        await gate.held
        return 'synced'
      }
    }
    const backend = new MemoryLockBackend()
    const [a, b] = [await replica(backend, [Sync]), await replica(backend, [Sync])]

    const first = a.container.get(Sync).run()
    await gate.running

    expect(await b.container.get(Sync).run()).toBeUndefined()
    expect(await a.container.get(Sync).run()).toBeUndefined()
    gate.release()
    expect(await first).toBe('synced')
    expect(await b.container.get(Sync).run()).toBe('synced')
    expect(runs).toBe(2)
  })
})

describe('@Once', () => {
  it('runs a method once per window across two applications, and again once the window closed', async () => {
    let runs = 0
    class Warmer {
      @Once('cache:warm', { ttl: 1 * Hour })
      async warm(): Promise<number | undefined> {
        runs += 1
        return runs
      }
    }
    const backend = new MemoryLockBackend()
    const [a, b] = [await replica(backend, [Warmer]), await replica(backend, [Warmer])]
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    expect(await a.container.get(Warmer).warm()).toBe(1)
    expect(await b.container.get(Warmer).warm()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1 * Hour - 1 * Millisecond)
    expect(await a.container.get(Warmer).warm()).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1 * Millisecond)

    expect(await b.container.get(Warmer).warm()).toBe(2)
  })
})

describe('@LeaderOnly', () => {
  it('runs a leader-only method on one of two applications only, and on the other once the first closes', async () => {
    const ran: string[] = []
    class Scheduler {
      static next = 0
      readonly name = `replica-${Scheduler.next++}`

      // A lease far longer than the test: the handover can only come from the closing replica releasing it.
      @LeaderOnly('scheduler', { ttl: 1 * Hour })
      async tick(): Promise<void> {
        ran.push(this.name)
      }
    }
    const backend = new MemoryLockBackend()
    const [a, b] = [await replica(backend, [Scheduler]), await replica(backend, [Scheduler])]
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // Both replicas campaign from bootstrap: the election settles before the first tick.
    await vi.advanceTimersByTimeAsync(0)
    const [sa, sb] = [a.container.get(Scheduler), b.container.get(Scheduler)]

    for (let tick = 0; tick < 3; tick++) {
      await sa.tick()
      await sb.tick()
      await vi.advanceTimersByTimeAsync(1 * Second)
    }
    expect(ran).toHaveLength(3)
    const leader = ran[0]!
    expect(new Set(ran)).toEqual(new Set([leader]))

    const [closing, staying] = leader === sa.name ? [a, sb] : [b, sa]
    await closing.close()
    // Within one backoff pause.
    await vi.advanceTimersByTimeAsync(100 * Millisecond)
    ran.length = 0
    await staying.tick()

    expect(ran).toEqual([staying.name])
  })
})

describe('DistLockAOP()', () => {
  class Job {
    @OneAtATime('job')
    async run(): Promise<boolean | undefined> {
      return true
    }
  }

  it('fails at bootstrap when DistLockAOP is installed without DistributedLock', async () => {
    await expect(replica(new MemoryLockBackend(), [Job], { lock: false })).rejects.toThrow(ErrFeatureNotInstalled)
  })

  // The decorators only write annotations: without the feature, nothing reads them.
  it('leaves a decorated method unwoven when DistLockAOP is not installed', async () => {
    const backend = new MemoryLockBackend()
    const app = await replica(backend, [Job], { aop: false })
    const held = await backend.tryAcquire('job', 1 * Hour)

    expect(held).toBeDefined()
    expect(await app.container.get(Job).run()).toBe(true)
  })

  it('is deduplicated: installing DistLockAOP twice is refused', () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(DistLockAOP())

    expect(() => app.install(DistLockAOP())).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('composes LeaderOnly and OneAtATime on one method', async () => {
    const gate = latch()
    let hold = false
    const ran: string[] = []
    class Owned {
      static next = 0
      readonly name = `replica-${Owned.next++}`

      // Written with exclusion outermost: the order they apply in is fixed, ownership first, whatever the order written.
      @OneAtATime('owned:run')
      @LeaderOnly('owned')
      async run(): Promise<string | undefined> {
        ran.push(this.name)
        if (hold) {
          gate.started()
          await gate.held
        }
        return this.name
      }
    }
    const backend = new MemoryLockBackend()
    const [a, b] = [await replica(backend, [Owned]), await replica(backend, [Owned])]
    await new Promise(resolve => setImmediate(resolve))
    const [oa, ob] = [a.container.get(Owned), b.container.get(Owned)]
    const leader = (await oa.run()) ?? (await ob.run())
    const [owner, follower] = leader === oa.name ? [oa, ob] : [ob, oa]
    ran.length = 0

    // The follower calls first: skipped by ownership, it never takes the exclusion key from the leader.
    hold = true
    const both = Promise.all([follower.run(), owner.run()])
    await gate.running
    // Exclusion skips the leader's own overlapping call.
    const overlapping = await owner.run()
    gate.release()

    expect(await both).toEqual([undefined, owner.name])
    expect(overlapping).toBeUndefined()
    expect(ran).toEqual([owner.name])
  })

  // The campaign holds the key while it leads, so the leader's own guard would find it held on every call.
  it('fails at bootstrap when one method names the same key for @LeaderOnly and another decorator', async () => {
    class Clash {
      @OneAtATime('reports')
      @LeaderOnly('reports')
      async run(): Promise<void> {}
    }

    await expect(replica(new MemoryLockBackend(), [Clash])).rejects.toThrow(ErrDistLockConfiguration)
  })

  // The container weaves instance methods it can reach by name only: the method would run unguarded.
  it('fails at bootstrap when a decorator is on a static or a private method', async () => {
    class OnStatic {
      @OneAtATime('static')
      static async run(): Promise<void> {}
    }
    class OnPrivate {
      @Once('private')
      async #run(): Promise<void> {}

      async run(): Promise<void> {
        await this.#run()
      }
    }

    await expect(replica(new MemoryLockBackend(), [OnStatic])).rejects.toThrow(ErrDistLockConfiguration)
    await expect(replica(new MemoryLockBackend(), [OnPrivate])).rejects.toThrow(ErrDistLockConfiguration)
  })

  it('refuses an empty key when the class is defined', () => {
    expect(() => {
      class Broken {
        @OneAtATime('')
        async run(): Promise<void> {}
      }
      return Broken
    }).toThrow(ErrInvalidLockKey)
  })
})
