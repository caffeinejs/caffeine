import { HealthIndicator, up, down, type HealthReport } from '@caffeinejs/application/health'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { devTools } from '../devtools.js'
import type { HealthRecord } from './health.js'

/** The probes answer a status; an operator chasing why needs each indicator's details, which only this shows. */
describe('HealthTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

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

  async function boot(): Promise<void> {
    app = createWebApplication()
      .server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
      .with(devTools()) as WebApplication
    app.container.bind(Database, t => t.toSelf().extends(HealthIndicator))
    app.container.bind(Mailer, t => t.toSelf().extends(HealthIndicator))
    // Readiness asks its indicators only once the application has started.
    await app.run()
  }

  it('shows every indicator with its details, and the availability', async () => {
    await boot()

    const health = (await (await app!.fetch('/devtools/health')).json()) as HealthRecord

    expect(health.groups.readiness.outcomes).toEqual([
      expect.objectContaining({ name: 'database', status: 'up', data: { pool: 4 } }),
      expect.objectContaining({ name: 'mailer', status: 'down', detail: 'smtp unreachable', critical: false }),
    ])
    expect(health.availability).toMatchObject({ live: 'correct', draining: false })
  })

  it('answers one group, and 404 for a group there is not', async () => {
    await boot()

    const readiness = await app!.fetch('/devtools/health/readiness')

    expect(readiness.status).toBe(200)
    expect(((await readiness.json()) as { outcomes: unknown[] }).outcomes).toHaveLength(2)
    expect((await app!.fetch('/devtools/health/wellness')).status).toBe(404)
  })
})
