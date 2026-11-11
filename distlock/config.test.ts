import { createApplication, newConfiguration } from '@caffeinejs/application'
import { ErrConfigValidation, type InferConfig } from '@caffeinejs/application/config'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { Millisecond, Second, type Duration } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DistLockConfigSchema } from './_spectypes/index.js'
import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import type { DistLock } from './distlock.js'
import { ErrDistLockConfiguration, ErrLockBackendTimeout } from './errors.js'
import { kDistLock, kDistLockBackend } from './keys.js'
import { DistributedLock } from './plugin.js'

/**
 * Records the lease duration of every attempt, so a resolved setting can be observed from outside: `ttls[0]`
 * is what `ttl` resolved to, and `ttls.length` is how many times the retry loop came round.
 */
class SpyBackend implements Backend {
  readonly ttls: number[] = []

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    this.ttls.push(ttl)
    return this.#inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    return this.#inner.extend(lease, ttl)
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}

/** Never answers an attempt, so the store timeout is what ends it. */
class HangingBackend implements Backend {
  tryAcquire(): Promise<LockLease | undefined> {
    return new Promise(() => undefined)
  }

  extend(): Promise<LockLease | undefined> {
    return new Promise(() => undefined)
  }

  release(): Promise<void> {
    return new Promise(() => undefined)
  }
}

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const close of opened.splice(0)) {
    await close()
  }
})

const appConfigSchema = $t.Object(
  { app: $t.Object({ distlock: $t.Object(DistLockConfigSchema.properties, { default: {} }) }, { default: {} }) },
  { default: {} },
)

type AppConfig = InferSchema<typeof appConfigSchema>

// The slice as a source writes it, before validation decodes the durations into milliseconds.
interface DistLockTree {
  ttl?: string
  wait?: string
  retryDelay?: string
  maxRetryDelay?: string
  retryJitter?: number
  storeTimeout?: string
}

/** Boots an application whose configuration tree carries the given distlock slice. */
async function newLock(
  backend: Backend,
  tree: DistLockTree,
  fluent?: (d: DistLockBuilder<AppConfig>) => void,
): Promise<DistLock> {
  const conf = newConfiguration(appConfigSchema)
    .source(new InlineConfigSource({ app: { distlock: tree } }))
    .build().config

  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
    DistributedLock<AppConfig>((d, { config }) => {
      d.backend(backend).config(config.app.distlock)
      fluent?.(d)
    }),
  )

  await app.bootstrap()
  opened.push(() => app.close())

  return app.container.get(kDistLock)
}

describe('distlock configuration', () => {
  it('reads the lease duration out of the configuration tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { ttl: '45s' })

    await lock.tryAcquire('k')

    expect(backend.ttls).toEqual([45_000])
  })

  // A setting written in code is the last word: configuration retunes what code did not decide, it does not
  // overrule it. Without this a deployment could silently shorten a lease an author pinned on purpose.
  it('lets a fluent method win over the same setting in the tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { ttl: '45s' }, d => d.ttl(10 * Second))

    await lock.tryAcquire('k')

    expect(backend.ttls).toEqual([10_000])
  })

  it('falls back to the built-in default when neither says', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, {})

    await lock.tryAcquire('k')

    expect(backend.ttls).toEqual([30_000])
  })

  // The wait budget ends up in the error a caller has to read, so a deployment that retunes it and a call
  // that does not say are both visible right there.
  it('reads the wait budget out of the configuration tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { wait: '60ms', retryDelay: '5ms' })
    await lock.acquire('k')

    const error = await lock.acquire('k').catch((e: unknown) => e)

    expect((error as Error).message).toContain('still held after 60ms')
  })

  it('lets a fluent wait win over the same setting in the tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { wait: '60ms', retryDelay: '5ms' }, d => d.wait(30))
    await lock.acquire('k')

    const error = await lock.acquire('k').catch((e: unknown) => e)

    expect((error as Error).message).toContain('still held after 30ms')
  })

  // The retry delay is only observable in how often the loop comes round, so the assertion is on the count:
  // 5ms across a 200ms budget is tens of attempts, where the 100ms default would be two or three.
  it('reads the retry delay out of the configuration tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { wait: '200ms', retryDelay: '5ms', retryJitter: 0 })
    await lock.acquire('k')

    const before = backend.ttls.length
    await lock.acquire('k').catch(() => undefined)

    expect(backend.ttls.length - before).toBeGreaterThan(5)
  })

  it('lets a fluent retry delay win over the same setting in the tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { wait: '200ms', retryDelay: '200ms', retryJitter: 0 }, d => d.retryDelay(5))
    await lock.acquire('k')

    const before = backend.ttls.length
    await lock.acquire('k').catch(() => undefined)

    expect(backend.ttls.length - before).toBeGreaterThan(5)
  })

  // The schema bounds the tree. Nothing bounded the setter, and a jitter above 1 silently stretches every
  // pause past the budget it was supposed to fit inside.
  it('refuses to start when the retry jitter is outside 0..1', async () => {
    const conf = newConfiguration(appConfigSchema).source(new InlineConfigSource({})).build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>(d => d.backend(new MemoryLockBackend()).retryJitter(2)),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  // Capped at 10ms the pauses stay flat: an attempt every 10ms over 100ms makes 11, where doubling up to the 1s
  // default makes 5 (at 0, 10, 30, 70 and 100ms).
  it('reads maxRetryDelay out of the tree', async () => {
    const backend = new SpyBackend()
    const lock = await newLock(backend, { wait: '100ms', retryDelay: '10ms', maxRetryDelay: '10ms', retryJitter: 0 })
    await lock.acquire('k')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const before = backend.ttls.length
    const contended = lock.acquire('k').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100 * Millisecond)
    await contended

    // One attempt every 10ms from 0 to 90ms: the pause that reaches the 100ms deadline ends the wait.
    expect(backend.ttls.length - before).toBe(10)
  })

  it('refuses a negative retryDelay', async () => {
    const conf = newConfiguration(appConfigSchema).source(new InlineConfigSource({})).build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>(d => d.backend(new MemoryLockBackend()).retryDelay(-1 * Millisecond)),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  it('refuses a maxRetryDelay below retryDelay', async () => {
    const conf = newConfiguration(appConfigSchema).source(new InlineConfigSource({})).build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>(d =>
        d
          .backend(new MemoryLockBackend())
          .retryDelay(500 * Millisecond)
          .maxRetryDelay(100 * Millisecond),
      ),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  // A jitter of 1 spreads a pause down to zero, which puts every waiter back on the same tick.
  it('refuses a retry jitter of 1', async () => {
    const conf = newConfiguration(appConfigSchema).source(new InlineConfigSource({})).build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>(d => d.backend(new MemoryLockBackend()).retryJitter(1)),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  it('refuses a retry jitter of 1 in the tree', async () => {
    await expect(newLock(new SpyBackend(), { retryJitter: 1 })).rejects.toThrow(/retryJitter/)
  })

  // A bare number names no unit. Read as duration text it was a lease of 0, which lapses as it is granted.
  it('refuses a duration the tree gives as a bare number', async () => {
    const conf = newConfiguration(appConfigSchema)
      .source(new InlineConfigSource({ app: { distlock: { ttl: '30000' } } }))
      .build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>((d, { config }) => d.backend(new MemoryLockBackend()).config(config.app.distlock)),
    )
    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfigValidation)
    await expect(booting).rejects.toThrow('app.distlock.ttl')
  })

  // The bound is only observable through what a backend that never answers produces: the error names it.
  it('reads the store timeout out of the configuration tree', async () => {
    const lock = await newLock(new HangingBackend(), { storeTimeout: '30ms' })

    const error = await lock.tryAcquire('k').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrLockBackendTimeout)
    expect((error as ErrLockBackendTimeout).timeout).toBe(30)
  })

  it('lets a fluent store timeout win', async () => {
    const lock = await newLock(new HangingBackend(), { storeTimeout: '1m' }, d => d.storeTimeout(20))

    const error = await lock.tryAcquire('k').catch((e: unknown) => e)

    expect((error as ErrLockBackendTimeout).timeout).toBe(20)
  })

  // Zero must not mean "no bound": a backend that stops answering would hang every caller and shutdown with it.
  it('refuses a store timeout of zero', async () => {
    const conf = newConfiguration(appConfigSchema).source(new InlineConfigSource({})).build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>(d => d.backend(new MemoryLockBackend()).storeTimeout(0)),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  // Node fires a timer longer than 2^31 - 1 ms after 1 ms, which would time out every backend call.
  it('refuses a store timeout above 2^31 - 1 ms', async () => {
    const conf = newConfiguration(appConfigSchema).source(new InlineConfigSource({})).build().config

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(
      DistributedLock<AppConfig>(d => d.backend(new MemoryLockBackend()).storeTimeout(2 ** 31)),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  // The schema is internal to the package for now; the feature never reads it.
  it('does not export the config schema from the package barrel', async () => {
    const barrel: Record<string, unknown> = await import('./index.js')

    expect(Object.keys(barrel).filter(name => name.endsWith('ConfigSchema'))).toEqual([])
  })

  // Failing at start-up rather than at the first lock: a fleet that booted without a backend has already told
  // its orchestrator it is healthy.
  it('refuses to start without a backend', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(DistributedLock())

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  it('refuses to start when the backend key resolves to nothing', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
      DistributedLock(d => d.backend(kDistLockBackend)),
    )

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  it('resolves a backend bound under a key', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(kDistLockBackend, t => t.toValue(new MemoryLockBackend()))

    const app = createApplication({ container }).install(DistributedLock(d => d.backend(kDistLockBackend)))

    await app.bootstrap()
    opened.push(() => app.close())

    expect(await app.container.get(kDistLock).tryAcquire('k')).toBeDefined()
  })
})
