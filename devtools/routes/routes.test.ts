import { brewer } from '@caffeinejs/brewer'
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

import { DevTools, type DevToolsRoutes } from '../devtools.js'

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
describe('routesRouter', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  const loopback = { host: '127.0.0.1', port: 0 }

  /** The devtools of an application with two servers besides theirs, read as `user` when one is named. */
  async function boot(user?: string) {
    app = createWebApplication({ logger: false })
      .server(() => ({ listener: loopback }))
      .install(Authentication(a => a.addStrategy('Header', new HeaderScheme())))
      .install(Authorization(z => z.requireAuthenticatedByDefault({ except: ['/livez'] })))
      .install(Listener('admin', l => l.server(() => ({ listener: loopback })).with(authentication())))
      .install(DevTools(d => d.port(0)))
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
    await app.run()

    // The fallback policy reaches the devtools too: their own server runs the gate.
    return brewer<DevToolsRoutes>(`${app.listeners.get('devtools')!.address!.origin}/devtools`, {
      headers: user === undefined ? {} : { 'x-user': user },
    })
  }

  async function servers(devtools: Awaited<ReturnType<typeof boot>>, server?: string) {
    const res = await devtools.routes.get({ query: server === undefined ? {} : { server } })

    expect(res.status).toBe(200)
    return res.status === 200 ? res.json() : []
  }

  it("lists every server's routes, the devtools' own and a probe's included", async () => {
    const devtools = await boot('ops')

    const listed = await servers(devtools)

    expect(listed.map(server => server.server)).toEqual(['', 'admin', 'devtools'])
    expect(listed[0]!.routes.map(route => route.url)).toEqual(expect.arrayContaining(['/pets', '/livez']))
    expect(listed[1]!.routes.map(route => route.url)).toEqual(['/jobs'])
    expect(listed[2]!.routes.map(route => route.url)).toContain('/devtools/routes')
    expect(listed[0]!.routes.find(route => route.url === '/pets')!.security.authorization.roleGroups).toEqual([
      ['keeper'],
    ])
  })

  it('answers one server when asked, the application’s own by its empty name', async () => {
    const devtools = await boot('ops')

    expect((await servers(devtools, 'admin')).map(server => server.server)).toEqual(['admin'])
    expect((await servers(devtools, '')).map(server => server.server)).toEqual([''])
  })

  it("puts the devtools under the application's fallback policy", async () => {
    const devtools = await boot()

    expect((await devtools.routes.get()).status).toBe(401)
  })

  it('names the schemes, the fallback policy and the gates of each server', async () => {
    const devtools = await boot('ops')

    const res = await devtools.routes.security.get()
    const security = await res.json()

    expect(res.status).toBe(200)
    expect(security.authentication).toEqual({ schemes: ['Header'], defaultScheme: 'Header' })
    expect(security.authorization).toMatchObject({ fallbackPolicy: expect.any(String), fallbackExcept: ['/livez'] })
    expect(security.gates).toEqual([
      { server: '', gates: ['default'] },
      { server: 'admin', gates: ['default'] },
      { server: 'devtools', gates: ['devtools'] },
    ])
  })
})
