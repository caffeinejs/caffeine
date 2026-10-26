import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  Authorization,
  BaseAuthenticationHandler,
  bindTo,
  Identity,
  Listener,
  Principal,
  type IContext,
  type WebApplication,
} from '@caffeinejs/http'
import { authentication, createWebApplication, healthProbes, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { DevTools } from '../devtools.js'
import type { SecurityRecord, ServerRoutesRecord } from './routes.js'

/** Authenticates whoever sends `x-user`. */
class HeaderScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    return ctx.req.header('x-user') === undefined
      ? AuthenticateResult.none()
      : AuthenticateResult.success(
          new AuthenticationTicket(new Principal(true, [new Identity('Header', true, [])]), 'Header'),
        )
  }
}

/**
 * The routes page answers "what can anyone reach, and what does each route require" for every server, the
 * devtools' own included, served from a server of its own: a route missing from it is one nobody reviews.
 */
describe('RoutesTool', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function boot(): Promise<void> {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Header', new HeaderScheme())))
      .install(Authorization(z => z.requireAuthenticatedByDefault({ except: ['/livez'] })))
      .install(Listener('admin', l => l.with(authentication())))
      .install(DevTools())
      .with(authentication())
      .with(healthProbes(h => h.enabled(true)))
      .mount(
        newRouter('/pets')
          .authorize({ roles: ['keeper'] })
          .get('/', () => []),
        newRouter('/jobs')
          .extend(bindTo('admin'))
          .get('/', () => []),
      ) as WebApplication
    await app.bootstrap()
  }

  async function get<T>(path: string): Promise<T> {
    // The fallback policy reaches the devtools too: their own server runs the gate.
    const res = await app!.listeners.get('devtools')!.fetch(`/devtools/routes${path}`, { headers: { 'x-user': 'ops' } })
    return (await res.json()) as T
  }

  it("lists every server's routes, the devtools' own and a probe's included", async () => {
    await boot()

    const servers = await get<ServerRoutesRecord[]>('')

    expect(servers.map(server => server.server)).toEqual(['', 'admin', 'devtools'])
    expect(servers[0].routes.map(route => route.url)).toEqual(expect.arrayContaining(['/pets', '/livez']))
    expect(servers[1].routes.map(route => route.url)).toEqual(['/jobs'])
    expect(servers[2].routes.map(route => route.url)).toContain('/devtools/routes')
    expect(servers[0].routes.find(route => route.url === '/pets')!.security.authorization.roleGroups).toEqual([
      ['keeper'],
    ])
  })

  it('answers one server when asked, the application’s own by its empty name', async () => {
    await boot()

    expect((await get<ServerRoutesRecord[]>('?server=admin')).map(server => server.server)).toEqual(['admin'])
    expect((await get<ServerRoutesRecord[]>('?server=')).map(server => server.server)).toEqual([''])
  })

  it("puts the devtools under the application's fallback policy", async () => {
    await boot()

    expect((await app!.listeners.get('devtools')!.fetch('/devtools/routes')).status).toBe(401)
  })

  it('names the schemes, the fallback policy and the gates of each server', async () => {
    await boot()

    const security = await get<SecurityRecord>('/security')

    expect(security.authentication).toEqual({ schemes: ['Header'], defaultScheme: 'Header' })
    expect(security.authorization).toMatchObject({ fallbackPolicy: expect.any(String), fallbackExcept: ['/livez'] })
    expect(security.gates).toEqual([
      { server: '', gates: ['default'] },
      { server: 'admin', gates: ['default'] },
      { server: 'devtools', gates: ['devtools'] },
    ])
  })
})
