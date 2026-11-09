import { createApplication } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Backend } from './backend.js'
import { FaultyBackend } from './backend.testkit.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { DistLockBuilder } from './builder.js'
import { DistributedLock } from './plugin.js'

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

// A started application, so readiness evaluates its indicators.
async function started(backend: Backend, configure: (d: DistLockBuilder) => void = d => d.health()) {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
    DistributedLock(d => configure(d.backend(backend))),
  )
  opened.push(() => app.close())
  await app.bootstrap()
  app.availability.markStarted().acceptTraffic()

  return app
}

const PROBE_KEY = 'caffeine:distlock:health'

describe('distlock health', () => {
  it('reports up once the backend answers, and hands the probe key back', async () => {
    const memory = new MemoryLockBackend()
    const app = await started(memory)

    const result = await app.health.readiness()

    expect(result.outcomes).toMatchObject([{ name: 'distlock', status: 'up', critical: false }])
    expect(await memory.tryAcquire(PROBE_KEY, 1 * Second)).toBeDefined()
  })

  // The backend answered: that another replica's probe holds the key says nothing against it.
  it("reports up when another replica's probe holds the key", async () => {
    const memory = new MemoryLockBackend()
    await memory.tryAcquire(PROBE_KEY, 1 * Second)
    const app = await started(memory)

    const result = await app.health.readiness()

    expect(result.outcomes).toMatchObject([{ name: 'distlock', status: 'up' }])
  })

  // The store is shared by every replica: failing readiness would take the whole fleet out of the Service at once.
  it('reports degraded with the first line of the error when the backend fails, and keeps readiness passing', async () => {
    const backend = new FaultyBackend()
    backend.failAcquire = true
    const app = await started(backend)

    const result = await app.health.readiness()

    expect(result.ok).toBe(true)
    expect(result.outcomes).toMatchObject([{ name: 'distlock', status: 'degraded', detail: 'backend down' }])
  })

  // Some clients reject with a bare string or object; the probe still has to say what the store answered.
  it('reports degraded with what the backend rejected with when it is not an Error', async () => {
    class StringRejectingBackend extends FaultyBackend {
      override tryAcquire(): Promise<undefined> {
        return Promise.reject('ECONNREFUSED 127.0.0.1:6379\nretrying')
      }
    }
    const app = await started(new StringRejectingBackend())

    const result = await app.health.readiness()

    expect(result.outcomes).toMatchObject([
      { name: 'distlock', status: 'degraded', detail: 'ECONNREFUSED 127.0.0.1:6379' },
    ])
  })

  // A hung store must not hold the probe, nor fail it: the answer comes within storeTimeout either way.
  it('reports degraded when the backend does not answer within storeTimeout', async () => {
    const backend = new FaultyBackend()
    backend.hang.add('acquire')
    const app = await started(backend, d => d.health().storeTimeout(100 * Millisecond))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const probe = app.health.readiness()
    await vi.advanceTimersByTimeAsync(100 * Millisecond)
    const result = await probe

    expect(result.ok).toBe(true)
    expect(result.outcomes).toMatchObject([{ name: 'distlock', status: 'degraded' }])
    expect(result.outcomes[0]!.detail).toMatch(/^Cannot acquire the lock on "caffeine:distlock:health"[^\n]*$/)
  })

  // Off by default, like every dependency check: a lock store is not every application's readiness concern.
  it('stays out of readiness unless enabled', async () => {
    const app = await started(new MemoryLockBackend(), () => undefined)

    const result = await app.health.readiness()

    expect(result.outcomes).toEqual([])
  })
})
