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
import { node } from '../../platform/node.testkit.js'
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

  // Under a router the probes serve at the router's path: a route of that router at a probe's path is the one refused.
  it("refuses to start when a route of the router already owns a probe path under the router's path", async () => {
    const app = track(
      createWebApplication().mount(
        new Router('/ops')
          .with(healthProbes(h => h.enabled(true)))
          .post('/readyz')
          .handler(() => 'x'),
      ),
    )

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrHealthConfiguration)
    await expect(booting).rejects.toThrow('already registered at "/ops/readyz"')
  })

  // A probe at "/" under a router serves at the router's path, where a route of the router is refused too.
  it("refuses to start when a route of the router owns the router's path and a probe is at '/'", async () => {
    const app = track(
      createWebApplication().mount(
        new Router('/ops')
          .with(healthProbes(h => h.enabled(true).paths({ ready: '/' })))
          .post('/')
          .handler(() => 'x'),
      ),
    )

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrHealthConfiguration)
    await expect(booting).rejects.toThrow('already registered at "/ops"')
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

  // Both register, as any plugin does twice; their routes claim the same paths.
  it('fails start-up with a route conflict when registered twice on one server', async () => {
    const app = track(createWebApplication().with(healthProbes()).with(healthProbes()))

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_ROUTE_CONFLICT' })
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

  describe('on Node', () => {
    it("leaves the application's global guards off the probes", async () => {
      const app = track(
        createWebApplication({ adapter: node() })
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
        createWebApplication({ adapter: node() })
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
