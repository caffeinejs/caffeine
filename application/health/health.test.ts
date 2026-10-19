import { describe, it, expect } from 'vitest'

import { ApplicationAvailability } from './availability.js'
import { ApplicationHealth } from './health.js'
import { HealthIndicator, type HealthGroup, type HealthReport, down, up } from './indicator.js'
import { defaultHealthRegistryOptions } from './options.js'
import { HealthRegistry } from './registry.js'

class Stub extends HealthIndicator {
  constructor(
    private readonly id: string,
    private readonly report: () => HealthReport,
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

  check(): HealthReport {
    return this.report()
  }
}

// Answers only once the test opens it, so a probe can be caught with its indicators still running.
class Gated extends HealthIndicator {
  readonly #answer = Promise.withResolvers<HealthReport>()

  constructor(
    private readonly id: string,
    private readonly groupList?: readonly HealthGroup[],
  ) {
    super()
  }

  get name(): string {
    return this.id
  }

  override get groups(): readonly HealthGroup[] {
    return this.groupList ?? super.groups
  }

  open(report: HealthReport): void {
    this.#answer.resolve(report)
  }

  check(): Promise<HealthReport> {
    return this.#answer.promise
  }
}

function booting(indicators: HealthIndicator[] = []): {
  health: ApplicationHealth
  availability: ApplicationAvailability
} {
  const availability = new ApplicationAvailability()
  const registry = new HealthRegistry(indicators, defaultHealthRegistryOptions())

  return { health: new ApplicationHealth(availability, registry), availability }
}

function running(indicators: HealthIndicator[] = []): {
  health: ApplicationHealth
  availability: ApplicationAvailability
} {
  const made = booting(indicators)
  made.availability.markStarted().acceptTraffic()
  return made
}

describe('ApplicationHealth', () => {
  describe('liveness', () => {
    it('passes while a readiness indicator is failing', async () => {
      const { health } = running([new Stub('db', () => down('connection refused'))])

      expect((await health.liveness()).ok).toBe(true)
      expect((await health.readiness()).ok).toBe(false)
    })

    it('passes while draining', async () => {
      const { health, availability } = running()

      availability.beginDrain()

      expect((await health.liveness()).ok).toBe(true)
    })

    it('passes before boot completes', async () => {
      const { health } = booting()

      expect((await health.liveness()).ok).toBe(true)
    })

    it('fails only when the process is explicitly marked broken, and says why', async () => {
      const { health, availability } = running()

      availability.markBroken('deadlocked')

      const result = await health.liveness()

      expect(result.ok).toBe(false)
      expect(result.checks).toEqual([{ name: 'live', ok: false, detail: 'deadlocked' }])
    })

    it('honours an indicator a user placed in the liveness group', async () => {
      const { health } = running([new Stub('deadlock', () => down('stuck'), ['liveness'])])

      expect((await health.liveness()).ok).toBe(false)
    })

    // A process marked broken while its indicators were running is not reported live: the restart waits for no
    // further poll.
    it('fails a call whose indicators were still running when the process was marked broken', async () => {
      const gated = new Gated('heartbeat', ['liveness'])
      const { health, availability } = running([gated])

      const pending = health.liveness()
      availability.markBroken('deadlocked')
      gated.open(up())

      const result = await pending

      expect(result.ok).toBe(false)
      expect(result.checks).toEqual([{ name: 'live', ok: false, detail: 'deadlocked' }])
    })
  })

  describe('readiness', () => {
    it('fails before boot completes', async () => {
      const { health } = booting()

      expect((await health.readiness()).ok).toBe(false)
    })

    it('passes once running', async () => {
      const { health } = running([new Stub('db', up)])

      const result = await health.readiness()

      expect(result.ok).toBe(true)
      expect(result.checks.map(check => check.name)).toEqual(['started', 'accepting', 'live'])
      expect(result.outcomes.map(outcome => outcome.name)).toEqual(['db'])
    })

    it('fails as soon as draining starts, naming the drain', async () => {
      const { health, availability } = running()

      availability.beginDrain()

      const result = await health.readiness()

      expect(result.ok).toBe(false)
      expect(result.checks).toContainEqual({ name: 'accepting', ok: false, detail: 'shutdown' })
    })

    // The poll the drain delay waits for: one that reported ready would keep routing traffic to a process about to
    // stop accepting it.
    it('fails a call whose indicators were still running when the drain began', async () => {
      const gated = new Gated('db')
      const { health, availability } = running([gated])

      const pending = health.readiness()
      availability.beginDrain()
      gated.open(up())

      const result = await pending

      expect(result.ok).toBe(false)
      expect(result.checks).toContainEqual({ name: 'accepting', ok: false, detail: 'shutdown' })
    })

    it('does not touch indicators while draining', async () => {
      let checked = false
      const indicator = new Stub('db', () => {
        checked = true
        return up()
      })
      const { health, availability } = running([indicator])

      availability.beginDrain()
      const result = await health.readiness()

      expect(checked).toBe(false)
      expect(result.outcomes).toEqual([])
    })

    it('stays up when a non-critical indicator is down, reporting it', async () => {
      const { health } = running([new Stub('metrics', () => down('unreachable'), undefined, false)])

      const result = await health.readiness()

      expect(result.ok).toBe(true)
      expect(result.outcomes).toMatchObject([
        { name: 'metrics', status: 'down', critical: false, detail: 'unreachable' },
      ])
    })
  })

  describe('startup', () => {
    it('fails before boot and passes after', async () => {
      const { health, availability } = booting()

      expect((await health.startup()).ok).toBe(false)

      availability.markStarted()

      expect((await health.startup()).ok).toBe(true)
    })

    it('keeps passing while draining, so a shutting-down pod is not treated as never-started', async () => {
      const { health, availability } = running()

      availability.beginDrain()

      expect((await health.startup()).ok).toBe(true)
    })
  })

  // In-process callers are trusted: whether an untrusted query string may exclude is the HTTP layer's decision.
  it('skips the named indicators', async () => {
    const { health } = running([new Stub('db', () => down('connection refused')), new Stub('cache', up)])

    const filtered = await health.readiness({ exclude: ['db'] })

    expect(filtered.ok).toBe(true)
    expect(filtered.outcomes.map(outcome => outcome.name)).toEqual(['cache'])
    expect((await health.readiness()).ok).toBe(false)
  })
})
