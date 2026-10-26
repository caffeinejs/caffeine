import { ApplicationAvailability, HealthIndicator, up, down, type HealthReport } from '@caffeinejs/application/health'
import { CaffeineIoC } from '@caffeinejs/di'
import { testClient } from '@caffeinejs/testing/http'
import { describe, expect, it } from 'vitest'

import { healthRouter } from './health.js'

/** The probes answer a status; an operator chasing why needs each indicator's details, which only this shows. */
describe('healthRouter', () => {
  class Database extends HealthIndicator {
    get name(): string {
      return 'database'
    }

    async check(): Promise<HealthReport> {
      return up({ pool: 4 })
    }
  }

  class Mailer extends HealthIndicator {
    get name(): string {
      return 'mailer'
    }

    override get critical(): boolean {
      return false
    }

    async check(): Promise<HealthReport> {
      return down('smtp unreachable')
    }
  }

  async function client() {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Database, t => t.toSelf().extends(HealthIndicator))
    container.bind(Mailer, t => t.toSelf().extends(HealthIndicator))
    const health = testClient(healthRouter(container), { container })
    await health.$ready()
    // Readiness asks its indicators only once the application has started and accepts traffic.
    container.get(ApplicationAvailability).markStarted().acceptTraffic()

    return health
  }

  it('shows every indicator with its details, and the availability', async () => {
    await using health = await client()

    const res = await health.health.get()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.groups.readiness.outcomes).toEqual([
      expect.objectContaining({ name: 'database', status: 'up', data: { pool: 4 } }),
      expect.objectContaining({ name: 'mailer', status: 'down', detail: 'smtp unreachable', critical: false }),
    ])
    expect(body.availability).toMatchObject({ live: 'correct', ready: 'accepting', draining: false })
  })

  it('answers one group, and 404 for a group there is not', async () => {
    await using health = await client()

    const readiness = await health.health({ group: 'readiness' }).get()
    const wellness = await health.health({ group: 'wellness' }).get()

    expect(readiness.status).toBe(200)
    if (readiness.status === 200) {
      expect((await readiness.json()).outcomes.map(outcome => outcome.name)).toEqual(['database', 'mailer'])
    }
    expect(wellness.status).toBe(404)
  })
})
