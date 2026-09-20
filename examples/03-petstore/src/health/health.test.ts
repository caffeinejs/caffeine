import { HealthIndicator, type HealthReport, down, up } from '@caffeinejs/std'
import { newTestContainer } from '@caffeinejs/testing'
import { afterEach, describe, expect, it } from 'vitest'

import { createContainer } from '../app.container.js'
import { type PetstoreApp, buildApp } from '../app.js'
import { rootModule } from '../root.gen.mod.js'
import { DatabaseHealth } from './db.health.js'

// Ephemeral port: the probes only answer once `run()` has started listening, and the configured default (9999)
// would collide with anything else on the machine.
process.env.PETSTORE_SERVER__PORT = '0'

class FakeDatabaseHealth extends HealthIndicator {
  get name(): string {
    return 'database'
  }

  constructor(private readonly healthy: boolean) {
    super()
  }

  check(): HealthReport {
    return this.healthy ? up() : down('connection refused')
  }
}

async function start(fake: HealthIndicator): Promise<PetstoreApp> {
  const app = buildApp(
    newTestContainer(createContainer(rootModule))
      .override(DatabaseHealth, b => b.toValue(fake as unknown as DatabaseHealth).extends(HealthIndicator))
      .build(),
    { logger: false },
  )
  await app.run()
  return app
}

const probe = (app: PetstoreApp, url: string) => app.fetch(url, { method: 'GET' })

describe('health probes', () => {
  let app: PetstoreApp | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('reports ready once the database answers', async () => {
    app = await start(new FakeDatabaseHealth(true))

    expect((await probe(app, '/readyz')).status).toBe(200)
    expect((await probe(app, '/livez')).status).toBe(200)
    expect((await probe(app, '/startupz')).status).toBe(200)
  })

  it('fails readiness but never liveness when the database is unreachable', async () => {
    app = await start(new FakeDatabaseHealth(false))

    expect((await probe(app, '/readyz')).status).toBe(503)
    // The pod must not be restarted because Postgres blinked — restarting repairs nothing.
    expect((await probe(app, '/livez')).status).toBe(200)
    expect((await probe(app, '/startupz')).status).toBe(200)
  })

  it('refuses readiness as soon as shutdown begins, without touching the database', async () => {
    let checks = 0
    const indicator = new (class extends HealthIndicator {
      get name(): string {
        return 'database'
      }
      check(): HealthReport {
        checks++
        return up()
      }
    })()

    const started = await start(indicator)
    try {
      const before = checks

      const closing = started.close()

      expect((await probe(started, '/readyz')).status).toBe(503)
      // A draining pod answers from its own state; hammering the database on the way out helps nobody.
      expect(checks).toBe(before)

      await closing
    } finally {
      await started.close()
    }
  })

  it('leaves the probes reachable without authentication', async () => {
    app = await start(new FakeDatabaseHealth(true))

    // Every other route in this application sits behind an authentication scheme.
    expect((await probe(app, '/readyz')).status).toBe(200)
    expect((await probe(app, '/api/v1/pets')).status).not.toBe(200)
  })
})
