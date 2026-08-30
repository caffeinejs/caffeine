import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Scopes, type Ctor } from '@caffeinejs/di'
import { HealthIndicator, type HealthReport, type ServiceAPI, down, up } from '@caffeinejs/std'
import { Authorize, Controller, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { ErrHealthIndicatorNotSingleton } from '../health/errors.js'
import type { HealthBuilder } from '../health/health_builder.js'
import type { WebApplication } from '../application.js'

class DownIndicator extends HealthIndicator {
  get name(): string {
    return 'db'
  }

  check(): HealthReport {
    return down('connection refused')
  }
}

class DegradedIndicator extends HealthIndicator {
  get name(): string {
    return 'metrics'
  }

  get critical(): boolean {
    return false
  }

  check(): HealthReport {
    return down('unreachable')
  }
}

class UpIndicator extends HealthIndicator {
  get name(): string {
    return 'cache'
  }

  check(): HealthReport {
    return up()
  }
}

function bindIndicators(app: WebApplication, ...indicators: Array<Ctor<HealthIndicator> | HealthIndicator>): void {
  for (const indicator of indicators) {
    if (typeof indicator === 'function') {
      app.container.bind(indicator).toSelf().extends(HealthIndicator)
    } else {
      app.container
        .bind(indicator.constructor as Ctor<HealthIndicator>)
        .toValue(indicator)
        .extends(HealthIndicator)
    }
  }
}

async function start(
  configure?: (health: ServiceAPI<HealthBuilder<unknown>>) => void,
  ...indicators: Array<Ctor<HealthIndicator> | HealthIndicator>
): Promise<WebApplication> {
  const app = createWebApplication(fastifyAdapterFactory(fastify()))
    .health(configure ?? (() => {}))
    .build()

  bindIndicators(app, ...indicators)
  await app.run()

  return app
}

const probe = (app: WebApplication, url: string) => app.fetch(url)

describe('health probes', () => {
  it('mounts the three probes with kubernetes paths', async () => {
    const app = await start()

    try {
      expect((await probe(app, '/livez')).status).toBe(200)
      expect((await probe(app, '/readyz')).status).toBe(200)
      expect((await probe(app, '/startupz')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('does not mount them when the feature is disabled', async () => {
    const app = await start(h => h.enabled(false))

    try {
      expect((await probe(app, '/readyz')).status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('does not mount them when health was never configured and Kubernetes is absent', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.run()

    try {
      expect((await probe(app, '/readyz')).status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('serves custom paths', async () => {
    const app = await start(h => h.paths({ ready: '/health/ready' }))

    try {
      expect((await probe(app, '/health/ready')).status).toBe(200)
      expect((await probe(app, '/readyz')).status).toBe(404)
      expect((await probe(app, '/livez')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('fails readiness while keeping liveness up when a critical indicator is down', async () => {
    const app = await start(undefined, DownIndicator)

    try {
      const ready = await probe(app, '/readyz')

      expect(ready.status).toBe(503)
      expect(await ready.text()).toBe('readyz check failed')

      // The whole reason the probes are separate: a failing dependency must never restart the container.
      expect((await probe(app, '/livez')).status).toBe(200)
      expect((await probe(app, '/startupz')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('stays ready when a non-critical indicator is down', async () => {
    const app = await start(undefined, DegradedIndicator, UpIndicator)

    try {
      expect((await probe(app, '/readyz')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('discovers an indicator bound on the container', async () => {
    const app = await start(undefined, DownIndicator)

    try {
      expect((await probe(app, '/readyz')).status).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('discovers an indicator instance bound on the container', async () => {
    const app = await start(undefined, new DownIndicator())

    try {
      expect((await probe(app, '/readyz')).status).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('rejects a non-singleton indicator at ready', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify())).health().build()
    app.container.bind(DownIndicator).toSelf().lifetime(Scopes.TRANSIENT).extends(HealthIndicator)

    try {
      await expect(app.ready()).rejects.toThrow(ErrHealthIndicatorNotSingleton)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('answers HEAD without a body', async () => {
    const app = await start()

    try {
      const response = await app.fetch('/readyz', { method: 'HEAD' })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('')
    } finally {
      await app.close()
    }
  })

  it('marks probe responses as uncacheable', async () => {
    const app = await start()

    try {
      const response = await probe(app, '/readyz')

      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    } finally {
      await app.close()
    }
  })

  describe('verbose', () => {
    it('is ignored unless enabled', async () => {
      const app = await start(undefined, UpIndicator)

      try {
        expect(await (await probe(app, '/readyz?verbose')).text()).toBe('ok')
      } finally {
        await app.close()
      }
    })

    it('lists the checks when enabled', async () => {
      const app = await start(h => h.verbose(), UpIndicator, DownIndicator)

      try {
        const response = await probe(app, '/readyz?verbose')

        const text = await response.text()

        expect(response.status).toBe(503)
        expect(text).toContain('[+]cache ok')
        expect(text).toContain('[-]db failed: connection refused')
        expect(text).toContain('readyz check failed')
      } finally {
        await app.close()
      }
    })
  })

  describe('exclude', () => {
    it('is ignored unless enabled, so a query string cannot make readiness lie', async () => {
      const app = await start(undefined, DownIndicator)

      try {
        expect((await probe(app, '/readyz?exclude=db')).status).toBe(503)
      } finally {
        await app.close()
      }
    })

    it('skips the named indicators when enabled', async () => {
      const app = await start(h => h.exclude(), DownIndicator, UpIndicator)

      try {
        expect((await probe(app, '/readyz?exclude=db')).status).toBe(200)
        expect((await probe(app, '/readyz?exclude=db,cache')).status).toBe(200)
        expect((await probe(app, '/readyz?exclude=cache')).status).toBe(503)
      } finally {
        await app.close()
      }
    })
  })

  // Declared last: the container snapshots the controller registry when it is constructed, so a controller
  // declared inside an earlier test would be picked up by every app built after it.
  it('keeps the probes reachable while an authorized route rejects anonymous callers', async () => {
    @Controller('/secured')
    @Authorize()
    class SecuredController {
      @Get('/data')
      data() {
        return {}
      }
    }

    void [SecuredController]

    const app = createWebApplication(fastifyAdapterFactory(fastify()))
      .authentication(auth => auth.addJWTBearer(o => o.secret('a-very-long-development-secret-value').allowAnyIssuer().allowAnyAudience()))
      .health()
      .build()
      .useAuthenticationAndAuthorization()

    await app.run()

    try {
      expect((await probe(app, '/secured/data')).status).toBe(401)
      expect((await probe(app, '/readyz')).status).toBe(200)
      expect((await probe(app, '/livez')).status).toBe(200)
    } finally {
      await app.close()
    }
  })
})
