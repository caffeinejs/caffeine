import { HealthIndicator, up, type HealthReport } from '@caffeinejs/application/health'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import {
  AuthenticateResult,
  Authentication,
  Authorization,
  BaseAuthenticationHandler,
  Guards,
  Router,
  type Guard,
} from '../../index.js'
import { createWebApplication as createFastifyApplication } from '../../platform/fastify/application.js'
import { ErrHealthConfiguration } from './errors.js'
import { healthProbes } from './plugin.js'

class UpIndicator extends HealthIndicator {
  get name(): string {
    return 'cache'
  }

  check(): HealthReport {
    return up()
  }
}

class DenyAll implements Guard {
  guard(): boolean {
    return false
  }
}

class NobodyScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

const opened: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close().catch(() => undefined)))
})

function track<A extends { close(): Promise<void> }>(app: A): A {
  opened.push(app)
  return app
}

describe('healthProbes', () => {
  it('answers each probe with ok, as plain text no cache keeps', async () => {
    const app = track(createWebApplication().with(healthProbes(h => h.enabled(true))))
    await app.run()

    for (const path of ['/livez', '/readyz', '/startupz']) {
      const res = await app.request(path)

      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toBe('ok')
      expect(res.headers.get('content-type'), path).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('cache-control'), path).toBe('no-store')
    }
  })

  it('answers HEAD with no body', async () => {
    const app = track(createWebApplication().with(healthProbes(h => h.enabled(true))))
    await app.run()

    const res = await app.request('/readyz', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('moves a probe to the path configured', async () => {
    const app = track(createWebApplication().with(healthProbes(h => h.enabled(true).paths({ ready: '/health/ready' }))))
    await app.run()

    expect((await app.request('/health/ready')).status).toBe(200)
    expect((await app.request('/readyz')).status).toBe(404)
  })

  it('mounts nothing when turned off', async () => {
    const app = track(createWebApplication().with(healthProbes(h => h.enabled(false))))
    await app.bootstrap()

    expect((await app.request('/readyz')).status).toBe(404)
  })

  it('refuses to start when a route already owns a probe path', async () => {
    const app = track(
      createWebApplication()
        .with(healthProbes(h => h.enabled(true)))
        .mount(new Router().get('/readyz').handler(() => 'x')),
    )

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrHealthConfiguration)
    await expect(booting).rejects.toThrow('already registered at "/readyz"')
  })

  // The kubelet sends no credential: a guard deciding access must never take the pod out of rotation.
  it("leaves the application's global guards off the probes", async () => {
    const app = track(
      createWebApplication()
        .install(Guards(g => g.global(DenyAll)))
        .with(healthProbes(h => h.enabled(true)))
        .mount(new Router('/x').get('/').handler(() => 'x')),
    )
    app.container.bind(DenyAll, t => t.toSelf())
    await app.run()

    expect((await app.request('/readyz')).status).toBe(200)
    expect((await app.request('/x')).status).toBe(403)
  })

  it("leaves the application's fallback policy off the probes", async () => {
    const app = track(
      createWebApplication()
        .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
        .install(Authorization(z => z.requireAuthenticatedByDefault()))
        .with(healthProbes(h => h.enabled(true))),
    )
    await app.run()

    expect((await app.request('/readyz')).status).toBe(200)
  })

  it('runs the root hooks for a probe', async () => {
    let count = 0
    const app = track(
      createWebApplication()
        .hook('onRequest', () => {
          count++
        })
        .with(healthProbes(h => h.enabled(true))),
    )
    await app.run()

    await app.request('/livez')

    expect(count).toBe(1)
  })

  it('refuses the plugin twice on one server', async () => {
    const app = track(createWebApplication().with(healthProbes()).with(healthProbes()))

    await expect(app.bootstrap()).rejects.toThrow(
      'Cannot register plugin "caffeine-health-probes" twice on the application\'s own server',
    )
  })

  describe('?verbose', () => {
    it('is ignored unless enabled', async () => {
      const app = track(createWebApplication().with(healthProbes(h => h.enabled(true))))
      app.container.bind(UpIndicator, t => t.toSelf().extends(HealthIndicator))
      await app.run()

      expect(await (await app.request('/readyz?verbose')).text()).toBe('ok')
    })

    it('lists each check when enabled', async () => {
      const app = track(createWebApplication().with(healthProbes(h => h.enabled(true).verbose())))
      app.container.bind(UpIndicator, t => t.toSelf().extends(HealthIndicator))
      await app.run()

      const text = await (await app.request('/readyz?verbose')).text()

      expect(text.split('\n')).toContain('[+]cache ok')
      expect(text.endsWith('readyz check passed\n')).toBe(true)
    })
  })

  describe('on Fastify', () => {
    it("leaves the application's global guards off the probes", async () => {
      const app = track(
        createFastifyApplication()
          .install(Guards(g => g.global(DenyAll)))
          .with(healthProbes(h => h.enabled(true))),
      )
      app.container.bind(DenyAll, t => t.toSelf())
      await app.run()

      expect((await app.request('/readyz')).status).toBe(200)
    })

    it('runs the root hooks for a probe', async () => {
      let count = 0
      const app = track(
        createFastifyApplication()
          .hook('onRequest', () => {
            count++
          })
          .with(healthProbes(h => h.enabled(true))),
      )
      await app.run()

      await app.request('/livez')

      expect(count).toBe(1)
    })
  })
})
