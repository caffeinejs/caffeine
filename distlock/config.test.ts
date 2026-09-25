import { CaffeineIoC, token } from '@caffeinejs/di'
import { createApplication, newConfiguration } from '@caffeinejs/std'
import { ErrConfigValidation, InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import { $t, type InferSchema } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import { distLockConfigSchema } from './config.js'
import type { DistLock } from './distlock.js'
import { ErrDistLockConfiguration } from './errors.js'
import { kDistLock, kDistLockBackend } from './keys.js'
import { distlock } from './plugin.js'

/**
 * Records the lease duration of every attempt, so a resolved setting can be observed from outside: `ttls[0]`
 * is what `ttl` resolved to, and `ttls.length` is how many times the retry loop came round.
 */
class SpyBackend implements Backend {
  readonly ttls: number[] = []

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttlMs: number): Promise<LockLease | undefined> {
    this.ttls.push(ttlMs)
    return this.#inner.tryAcquire(key, ttlMs)
  }

  extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined> {
    return this.#inner.extend(lease, ttlMs)
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

const appConfigSchema = $t.Object(
  { app: $t.Object({ distlock: $t.Object(distLockConfigSchema.properties, { default: {} }) }, { default: {} }) },
  { default: {} },
)

type AppConfig = InferSchema<typeof appConfigSchema>

// The slice as a source writes it, before validation decodes the durations into milliseconds.
interface DistLockTree {
  ttl?: string
  wait?: string
  retryDelay?: string
  retryJitter?: number
}

const kConfig = token<InferConfig<typeof appConfigSchema>>(Symbol('distlock.test.config'))

/** Boots an application whose configuration tree carries the given distlock slice. */
async function newLock(
  backend: Backend,
  tree: DistLockTree,
  fluent?: (d: DistLockBuilder<AppConfig>) => void,
): Promise<DistLock> {
  const conf = newConfiguration(appConfigSchema, kConfig)
    .source(new InlineConfigSource({ app: { distlock: tree } }))
    .build()

  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(
    distlock<AppConfig>((d, { config }) => {
      d.backend(backend).config(config.app.distlock)
      fluent?.(d)
    }),
  )

  await app.ready()
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
    const lock = await newLock(backend, { ttl: '45s' }, d => d.ttl('10s'))

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
    const conf = newConfiguration(appConfigSchema, kConfig).source(new InlineConfigSource({})).build()

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(
      distlock<AppConfig>(d => d.backend(new MemoryLockBackend()).retryJitter(2)),
    )

    await expect(app.ready()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  // A bare number names no unit. Read as duration text it was a lease of 0, which lapses as it is granted.
  it('refuses a duration the tree gives as a bare number', async () => {
    const conf = newConfiguration(appConfigSchema, kConfig)
      .source(new InlineConfigSource({ app: { distlock: { ttl: '30000' } } }))
      .build()

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(
      distlock<AppConfig>((d, { config }) => d.backend(new MemoryLockBackend()).config(config.app.distlock)),
    )
    const booting = app.ready()

    await expect(booting).rejects.toThrow(ErrConfigValidation)
    await expect(booting).rejects.toThrow('app.distlock.ttl')
  })

  it('publishes the schema from the barrel, so an application can compose it', async () => {
    const { distLockConfigSchema: fromBarrel } = await import('./index.js')

    expect(fromBarrel).toBe(distLockConfigSchema)
  })

  // Failing at start-up rather than at the first lock: a fleet that booted without a backend has already told
  // its orchestrator it is healthy.
  it('refuses to start without a backend', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).with(distlock())

    await expect(app.ready()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  it('refuses to start when the backend key resolves to nothing', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).with(
      distlock(d => d.backend(kDistLockBackend)),
    )

    await expect(app.ready()).rejects.toBeInstanceOf(ErrDistLockConfiguration)
  })

  it('resolves a backend bound under a key', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(kDistLockBackend, t => t.toValue(new MemoryLockBackend()))

    const app = createApplication({ container }).with(distlock(d => d.backend(kDistLockBackend)))

    await app.ready()
    opened.push(() => app.close())

    expect(await app.container.get(kDistLock).tryAcquire('k')).toBeDefined()
  })
})
