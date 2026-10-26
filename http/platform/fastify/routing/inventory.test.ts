import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  Authorization,
  BaseAuthenticationHandler,
  HTTPPlugin,
  Listener,
  Router,
  RouteInventory,
  bindTo,
  csrfExempt,
  type Guard,
  type RouteRecord,
  type ServerRoutes,
  type WebApplication,
} from '../../../index.js'
import { authentication, createWebApplication, csrf, healthProbes, newRouter } from '../index.js'

/**
 * The route inventory: every route of every server, described as the server decided it. A tool reading it (the
 * devtools routes page) must see a listener's routes, a probe a plugin registered raw, and what protects each one,
 * or it reports an application as safer than it is.
 */

class NobodyScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

describe('route inventory', () => {
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
    app = createWebApplication()
      .install(Listener('admin'))
      .mount(
        newRouter('/api').get('/', () => 'api'),
        newRouter('/jobs')
          .extend(bindTo('admin'))
          .get('/', () => 'jobs'),
      ) as WebApplication

    await app.bootstrap()

    expect(servers().map(entry => [entry.server, entry.routes.map(record => record.url)])).toEqual([
      [undefined, ['/api']],
      ['admin', ['/jobs']],
    ])
  })

  it('folds a GET route and its HEAD twin into one record', async () => {
    app = createWebApplication().mount(newRouter('/pets').get('/', () => [])) as WebApplication

    await app.bootstrap()

    expect(route(undefined, '/pets')?.methods).toEqual(['GET', 'HEAD'])
  })

  it('describes a compiled route: its group, handler, media types, status and schemas', async () => {
    app = createWebApplication().mount(
      new Router('/orders')
        .post('/')
        .name('create')
        .status(201)
        .produces('application/json')
        .handler(() => ({})),
    ) as WebApplication

    await app.bootstrap()

    expect(route(undefined, '/orders')).toMatchObject({
      methods: ['POST'],
      kind: 'compiled',
      handler: 'create',
      group: expect.any(String),
      produces: 'application/json',
      status: 201,
      schema: { params: false, querystring: false, headers: false, body: false, response: false },
    })
  })

  it('lists a raw route a plugin registered, such as a probe, as exempt from authentication', async () => {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .with(authentication())
      .with(healthProbes(h => h.enabled(true))) as WebApplication

    await app.bootstrap()

    expect(route(undefined, '/livez')).toMatchObject({
      kind: 'raw',
      methods: ['GET', 'HEAD'],
      security: {
        authentication: { skipped: true, schemes: [] },
        authorization: { protected: false },
      },
    })
  })

  it('lists the routes a plugin mounted on a listener under that listener', async () => {
    class Metrics extends HTTPPlugin {
      register(context: Parameters<HTTPPlugin['register']>[0]): void {
        context.app.mount(new Router('/metrics').get('/', () => 'up'))
      }
    }

    app = createWebApplication().install(Listener('admin', l => l.with(() => new Metrics()))) as WebApplication

    await app.bootstrap()

    expect(route('admin', '/metrics')?.kind).toBe('compiled')
    expect(route(undefined, '/metrics')).toBe(undefined)
  })

  it('names the gate that authenticates a route and its schemes, and no gate on a server without one', async () => {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .install(Listener('admin'))
      .with(authentication())
      .mount(
        newRouter('/me')
          .authorize({ roles: ['user'] })
          .get('/', () => 'me'),
        newRouter('/open')
          .extend(bindTo('admin'))
          .get('/', () => 'open'),
      ) as WebApplication

    await app.bootstrap()

    expect(route(undefined, '/me')?.security).toEqual({
      authentication: { skipped: false, schemes: ['Nobody'], allowAnonymous: false, gate: 'default' },
      authorization: { protected: true, fallback: false, policies: [], roleGroups: [['user']], defaultPolicy: false },
      guards: [],
      csrf: 'safe',
    })
    expect(route('admin', '/open')?.security.authentication.gate).toBe(undefined)
    expect(route('admin', '/open')?.security.authorization.protected).toBe(false)
  })

  it('names the guards a route runs, in order', async () => {
    class TenantGuard implements Guard {
      guard(): boolean {
        return true
      }
    }

    class AuditGuard implements Guard {
      guard(): boolean {
        return true
      }
    }

    app = createWebApplication().mount(
      newRouter('/tenants')
        .guards([TenantGuard, AuditGuard])
        .get('/', () => []),
    ) as WebApplication
    app.container.bind(TenantGuard, t => t.toSelf())
    app.container.bind(AuditGuard, t => t.toSelf())

    await app.bootstrap()

    expect(route(undefined, '/tenants')?.security.guards).toEqual(['TenantGuard', 'AuditGuard'])
  })

  it("says a route that declared nothing answers to the application's fallback policy", async () => {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme())))
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .with(authentication())
      .mount(newRouter('/undeclared').get('/', () => 'x')) as WebApplication

    await app.bootstrap()

    expect(route(undefined, '/undeclared')?.security.authorization).toMatchObject({ protected: true, fallback: true })
  })

  it('tells each cross-origin protection verdict apart', async () => {
    app = createWebApplication()
      .install(Listener('admin'))
      .with(csrf(c => c.exclude('/hooks')))
      .mount(
        newRouter('/forms').post('/', () => 'ok'),
        newRouter('/partner')
          .extend(csrfExempt())
          .post('/', () => 'ok'),
        newRouter('/hooks').post('/', () => 'ok'),
        newRouter('/hooks/kept')
          .extend(csrfExempt(false))
          .post('/', () => 'ok'),
        newRouter('/admin-forms')
          .extend(bindTo('admin'))
          .post('/', () => 'ok'),
      ) as WebApplication

    await app.bootstrap()

    expect(route(undefined, '/forms')?.security.csrf).toBe('protected')
    expect(route(undefined, '/partner')?.security.csrf).toBe('exempt')
    expect(route(undefined, '/hooks')?.security.csrf).toBe('excluded')
    expect(route(undefined, '/hooks/kept')?.security.csrf).toBe('protected')
    expect(route('admin', '/admin-forms')?.security.csrf).toBe('uncovered')
  })
})
