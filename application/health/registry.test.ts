import { describe, it, expect } from 'vitest'

import { HealthIndicator, type HealthGroup, type HealthReport, down, up } from './indicator.js'
import { HealthRegistry } from './registry.js'

const OPTIONS = { indicatorTimeoutMs: 50, probeDeadlineMs: 100, cacheTTLMs: 1_000 }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

class Stub extends HealthIndicator {
  calls = 0

  constructor(
    private readonly id: string,
    private readonly report: () => Promise<HealthReport> | HealthReport,
    private readonly groupList?: readonly HealthGroup[],
    private readonly isCritical?: boolean,
  ) {
    super()
  }

  get name(): string {
    return this.id
  }

  override get groups(): readonly HealthGroup[] {
    return this.groupList ?? super.groups
  }

  override get critical(): boolean {
    return this.isCritical ?? super.critical
  }

  check(): Promise<HealthReport> | HealthReport {
    this.calls++
    return this.report()
  }
}

describe('HealthRegistry', () => {
  it('defaults an indicator to the readiness group only', () => {
    const registry = new HealthRegistry([new Stub('db', up)], OPTIONS)

    expect(registry.has('readiness')).toBe(true)
    expect(registry.has('liveness')).toBe(false)
    expect(registry.has('startup')).toBe(false)
  })

  it('passes when every indicator is up', async () => {
    const registry = new HealthRegistry([new Stub('db', up), new Stub('cache', up)], OPTIONS)

    const outcome = await registry.evaluate('readiness')

    expect(outcome.ok).toBe(true)
    expect(outcome.degraded).toBe(false)
    expect(outcome.outcomes.map(o => o.name)).toEqual(['db', 'cache'])
  })

  it('fails the group when a critical indicator is down', async () => {
    const registry = new HealthRegistry([new Stub('db', () => down('connection refused'))], OPTIONS)

    const outcome = await registry.evaluate('readiness')

    expect(outcome.ok).toBe(false)
    expect(outcome.outcomes[0]).toMatchObject({ status: 'down', critical: true, detail: 'connection refused' })
  })

  it('degrades instead of failing when a non-critical indicator is down', async () => {
    const registry = new HealthRegistry([new Stub('metrics', () => down('unreachable'), undefined, false)], OPTIONS)

    const outcome = await registry.evaluate('readiness')

    expect(outcome.ok).toBe(true)
    expect(outcome.degraded).toBe(true)
  })

  it('reports a thrown check as down', async () => {
    const registry = new HealthRegistry(
      [
        new Stub('db', () => {
          throw new Error('boom')
        }),
      ],
      OPTIONS,
    )

    const outcome = await registry.evaluate('readiness')

    expect(outcome.ok).toBe(false)
    expect(outcome.outcomes[0].detail).toBe('boom')
  })

  it('times out an indicator that ignores its abort signal', async () => {
    const registry = new HealthRegistry(
      [
        new Stub('hung', async () => {
          await sleep(5_000)
          return up()
        }),
      ],
      OPTIONS,
    )

    const started = Date.now()
    const outcome = await registry.evaluate('readiness')

    expect(outcome.ok).toBe(false)
    expect(outcome.outcomes[0]).toMatchObject({ status: 'down', detail: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('aborts the signal handed to the indicator when it overruns', async () => {
    let aborted = false

    class Watcher extends HealthIndicator {
      get name(): string {
        return 'watcher'
      }

      check(signal: AbortSignal): Promise<never> {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )

        return new Promise<never>(() => {})
      }
    }

    const outcome = await new HealthRegistry([new Watcher()], OPTIONS).evaluate('readiness')

    expect(aborted).toBe(true)
    expect(outcome.outcomes[0]).toMatchObject({ status: 'down', detail: 'timeout' })
  })

  it('coalesces concurrent evaluations into one run', async () => {
    const indicator = new Stub('db', async () => {
      await sleep(20)
      return up()
    })
    const registry = new HealthRegistry([indicator], OPTIONS)

    await Promise.all([registry.evaluate('readiness'), registry.evaluate('readiness'), registry.evaluate('readiness')])

    expect(indicator.calls).toBe(1)
  })

  it('reuses a cached evaluation within the TTL and re-runs after it', async () => {
    const indicator = new Stub('db', up)
    const registry = new HealthRegistry([indicator], { ...OPTIONS, cacheTTLMs: 30 })

    await registry.evaluate('readiness')
    await registry.evaluate('readiness')
    expect(indicator.calls).toBe(1)

    await sleep(40)
    await registry.evaluate('readiness')
    expect(indicator.calls).toBe(2)
  })

  it('bypasses the cache when indicators are excluded', async () => {
    const db = new Stub('db', () => down('down'))
    const cache = new Stub('cache', up)
    const registry = new HealthRegistry([db, cache], OPTIONS)

    expect((await registry.evaluate('readiness')).ok).toBe(false)

    const filtered = await registry.evaluate('readiness', new Set(['db']))

    expect(filtered.ok).toBe(true)
    expect(filtered.outcomes.map(o => o.name)).toEqual(['cache'])
    expect(cache.calls).toBe(2)
  })

  it('returns an empty passing outcome for a group with no indicators', async () => {
    const registry = new HealthRegistry([], OPTIONS)

    const outcome = await registry.evaluate('liveness')

    expect(outcome).toEqual({ ok: true, degraded: false, outcomes: [] })
  })
})
