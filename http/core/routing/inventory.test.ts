import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { bindTo } from '../../decorators/bind_to.js'
import {
  AuthenticateResult,
  Authentication,
  authentication,
  Authorization,
  BaseAuthenticationHandler,
  csrf,
  HTTPPlugin,
  Router,
  RouteInventory,
  type Guard,
  type RouteRecord,
  type ServerRoutes,
  type WebApplication,
} from '../../index.js'
import { node } from '../../platform/node.testkit.js'
import type { HTTPSetupContext } from '../../plugin.js'
import { accessControlExempt } from '../security/exempt.js'

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>
type FetchApp = WebApplication<any, any, any>

/** A scheme that authenticates nobody: enough for a gate to be built. */
class NobodyScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

/**
 * A reader of the inventory sees every server's routes or none: a plugin that read it while servers were still being
 * built would report the application's routes as the few registered so far.
 */
describe('RouteInventory', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  it('refuses a read while servers are still being built', async () => {
    class ReadsTooEarly extends HTTPPlugin {
      register(context: HTTPSetupContext): void {
        void context.container.get(RouteInventory).servers
      }
    }

    app = createWebApplication({ adapter: node() }).with(() => new ReadsTooEarly()) as WebApplication

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_APPLICATION_NOT_READY' })
  })

  it('answers once the application has bootstrapped', async () => {
    app = createWebApplication({ adapter: node() }) as WebApplication

    await app.bootstrap()

    expect(app.container.get(RouteInventory).servers.map(server => server.server)).toEqual([undefined])
  })
})

// The fetch application's records report its gates and cross-origin protection, as each plugin's `onRoute` recorded
// them.
describe('routeRecord on the fetch application', () => {
  let app: FetchApp | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  class TenantGuard implements Guard {
    guard(): boolean {
      return true
    }
  }

  async function records(router: AnyRouter) {
    app = createWebApplication().mount(router)
    app.container.bind(TenantGuard, t => t.toSelf())
    await app.bootstrap()
    return app.container.get(RouteInventory).servers[0].routes
  }

  it('records a GET route with its HEAD twin as one record', async () => {
    const [record] = await records(new Router('/pets').get('/').handler(() => []))

    expect(record.methods).toEqual(['GET', 'HEAD'])
    expect(record.url).toBe('/pets')
  })

  it('records produces, status, timeout and guards', async () => {
    const [record] = await records(
      new Router('/reports')
        .guards([TenantGuard])
        .post('/')
        .produces('text/csv')
        .status(201)
        .timeout(5 * Second)
        .handler(() => 'id'),
    )

    expect(record).toMatchObject({ produces: 'text/csv', status: 201, timeout: 5 * Second })
    expect(record.security.guards).toEqual(['TenantGuard'])
  })

  it('reports no gate, no authorization and an uncovered POST', async () => {
    const [record] = await records(new Router('/orders').post('/').handler(() => 'id'))

    expect(record.security.authentication.gate).toBe(undefined)
    expect(record.security.authorization.protected).toBe(false)
    expect(record.security.csrf).toBe('uncovered')
  })

  it('reports a route the framework serves outside access control as skipped, with no scheme', async () => {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .mount(
        new Router('/marked')
          .config(accessControlExempt())
          .get('/')
          .handler(() => 'x'),
        new Router('/plain').get('/').handler(() => 'x'),
      )
    await app.bootstrap()
    const routes = app.container.get(RouteInventory).servers[0].routes
    const security = (url: string) => routes.find(record => record.url === url)?.security.authentication

    expect(security('/marked')).toEqual({ skipped: true, schemes: [], allowAnonymous: false, gate: undefined })
    expect(security('/plain')).toEqual({ skipped: false, schemes: ['Nobody'], allowAnonymous: false, gate: undefined })
  })

  describe('under a gate and cross-origin protection', () => {
    async function recordsOf(build: (app: FetchApp) => FetchApp) {
      app = build(createWebApplication().install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme()))))
      await app.bootstrap()
      const routes = app.container.get(RouteInventory).servers[0].routes
      return (url: string) => routes.find(record => record.url === url)!.security
    }

    it('names the gate of a protected route', async () => {
      const security = await recordsOf(a =>
        a.with(authentication()).mount(
          new Router('/p')
            .authorize({ roles: [] })
            .get('/')
            .handler(() => 'x'),
        ),
      )

      expect(security('/p').authentication.gate).toBe('default')
      expect(security('/p').authorization.protected).toBe(true)
      expect(security('/p').authorization.fallback).toBe(false)
    })

    it('reports a route the fallback policy protects', async () => {
      const security = await recordsOf(a =>
        a
          .install(Authorization(z => z.requireAuthenticatedByDefault()))
          .with(authentication())
          .mount(new Router('/u').get('/').handler(() => 'x')),
      )

      expect(security('/u').authorization.protected).toBe(true)
      expect(security('/u').authorization.fallback).toBe(true)
    })

    it('reports a route under exclude(...) as excluded, and any other unsafe one as protected', async () => {
      const security = await recordsOf(a =>
        a.with(csrf(c => c.exclude('/hooks'))).mount(
          new Router()
            .post('/hooks/x')
            .handler(() => 'x')
            .post('/form')
            .handler(() => 'x'),
        ),
      )

      expect(security('/hooks/x').csrf).toBe('excluded')
      expect(security('/form').csrf).toBe('protected')
    })
  })
})

// A tool reading the inventory (the devtools routes page) must see a listener's routes under that listener.
describe('route inventory across listeners', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  function servers(): readonly ServerRoutes[] {
    return app!.container.get(RouteInventory).servers
  }

  function route(server: string | undefined, url: string): RouteRecord | undefined {
    return servers()
      .find(entry => entry.server === server)
      ?.routes.find(record => record.url === url)
  }

  it("lists the application's own server first, then each listener with the routes bound to it alone", async () => {
    app = createWebApplication({ adapter: node() })
      .listener('admin')
      .mount(
        new Router('/api').get('/', () => 'api'),
        new Router('/jobs').extend(bindTo('admin')).get('/', () => 'jobs'),
      ) as WebApplication

    await app.bootstrap()

    expect(servers().map(entry => [entry.server, entry.routes.map(record => record.url)])).toEqual([
      [undefined, ['/api']],
      ['admin', ['/jobs']],
    ])
  })

  it('lists the routes a plugin mounted on a listener under that listener', async () => {
    class Metrics extends HTTPPlugin {
      register(context: HTTPSetupContext): void {
        context.app.mount(new Router('/metrics').get('/', () => 'up'))
      }
    }

    app = createWebApplication({ adapter: node() }).listener('admin', l =>
      l.with(() => new Metrics()),
    ) as WebApplication

    await app.bootstrap()

    expect(route('admin', '/metrics')?.kind).toBe('compiled')
    expect(route(undefined, '/metrics')).toBe(undefined)
  })
})
