import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { HealthIndicator, down, type HealthReport } from '@caffeinejs/std/health'
import { afterEach, describe, expect, it } from 'vitest'

import { health, type DevToolsHealthReport } from '../index.js'
import { get, target } from './fixtures.js'

class Database extends HealthIndicator {
  get name(): string {
    return 'database'
  }

  check(): HealthReport {
    return down('connection refused', { marker: 'in-process-only' })
  }
}

describe('the health slice', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // Readiness and startup fail until the application has started, so the report is read from a running one.
  it('reports availability and every probe, with each indicator outcome', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Database, t => t.toClass(Database).extends(HealthIndicator))

    app = target({ container })
    await app.run()

    const res = await get(app, '/devtools/health')
    const text = await res.text()
    const report = JSON.parse(text) as DevToolsHealthReport

    expect(report.availability).toMatchObject({ live: 'correct', ready: 'accepting', started: true, draining: false })
    expect(report.liveness.ok).toBe(true)
    expect(report.readiness.ok).toBe(false)
    expect(report.readiness.indicators).toEqual([
      {
        name: 'database',
        status: 'down',
        critical: true,
        detail: 'connection refused',
        durationMs: expect.any(Number),
      },
    ])

    // An indicator's `data` is for callers in the process: it never leaves it.
    expect(text).not.toContain('in-process-only')
  })

  // Building the probe service is what refuses an indicator that is not a singleton: that belongs to start-up.
  it('refuses to start over an indicator that is not a singleton', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Database, t => t.toClass(Database).extends(HealthIndicator).lifetime(Scopes.TRANSIENT))

    app = target({ container, devtools: d => d.slices(health()) })

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_HEALTH_INDICATOR_NOT_SINGLETON' })
  })
})
