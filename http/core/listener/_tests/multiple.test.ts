import { createServer, type Server } from 'node:net'

import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  type IContext,
  Identity,
  Listener,
  Principal,
  bindTo,
  type WebApplication,
} from '../../../index.js'
import {
  type HTTPPluginFactory,
  authentication,
  createWebApplication,
  healthProbes,
  newRouter,
} from '../../../platform/fastify/index.js'

/**
 * Scenario: several listeners with different settings.
 *
 * Each server is built from its own settings and serves the routers bound to it and nothing else: one server's
 * authorization, factory options and plugins never reach another, nor the application's own server.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** Authenticates `user[:role,role]` from `x-ops`. */
class OpsScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    const value = ctx.req.header('x-ops')
    if (value === undefined) {
      return AuthenticateResult.none()
    }

    const [user, roles = ''] = value.split(':')
    const claims = [new Claim('sub', user, ''), ...roles.split(',').map(role => new Claim('roles', role, ''))]

    return AuthenticateResult.success(
      new AuthenticationTicket(new Principal(true, [new Identity('Ops', true, claims)]), 'Ops'),
    )
  }
}

const operator = { 'x-ops': 'alice:operator' }

/**
 * Two listeners: `admin`, its router authorized behind a gate of its own and with a small body limit, and `metrics`, open and
 * serving the probes. `adminPlugin` is one more plugin on `admin`.
 */
function twoServers({ metricsPort = 0, adminPlugin }: { metricsPort?: number; adminPlugin?: HTTPPluginFactory } = {}) {
  return createWebApplication()
    .install(Authentication(a => a.addStrategy('Ops', new OpsScheme()).default('Ops')))
    .install(
      Listener('admin', l => {
        l.server(() => ({ factory: { bodyLimit: 64 }, listener })).with(authentication())

        if (adminPlugin !== undefined) {
          l.with(adminPlugin)
        }
      }),
    )
    .install(
      Listener('metrics', l => l.server(() => ({ listener: { ...listener, port: metricsPort } })).with(healthProbes())),
    )
    .server(() => ({ listener }))
    .mount(
      newRouter('/admin')
        .extend(bindTo('admin'))
        .authorize({ schemes: ['Ops'], roles: ['operator'] })
        .post('/echo', ctx => ({ received: ctx.req.body() })),
      newRouter('/metrics')
        .extend(bindTo('metrics'))
        .get('/', () => ({ up: true })),
      newRouter('/api').post('/echo', ctx => ({ received: ctx.req.body() })),
    ) as WebApplication
}

describe('several listeners with different settings', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  function origins(): { main: string; admin: string; metrics: string } {
    return {
      main: app!.address!.origin,
      admin: app!.listeners.get('admin')!.address!.origin,
      metrics: app!.listeners.get('metrics')!.address!.origin,
    }
  }

  async function status(url: string, init?: RequestInit): Promise<number> {
    return (await fetch(url, init)).status
  }

  const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  it("serves on each server its own routers, under its own authorization, and none of the others'", async () => {
    app = twoServers()
    await app.run()
    const { main, admin, metrics } = origins()

    expect(await status(`${admin}/admin/echo`, post({ a: 1 }))).toBe(401)
    expect(await status(`${admin}/admin/echo`, post({ a: 1 }, operator))).toBe(200)
    expect(await status(`${metrics}/metrics`)).toBe(200)
    expect(await status(`${metrics}/readyz`)).toBe(200)
    expect(await status(`${main}/api/echo`, post({ a: 1 }))).toBe(200)

    expect(await status(`${main}/admin/echo`, post({ a: 1 }, operator))).toBe(404)
    expect(await status(`${main}/metrics`)).toBe(404)
    expect(await status(`${main}/readyz`)).toBe(404)
    expect(await status(`${admin}/metrics`, { headers: operator })).toBe(404)
    expect(await status(`${admin}/readyz`, { headers: operator })).toBe(404)
    expect(await status(`${metrics}/admin/echo`, post({ a: 1 }, operator))).toBe(404)
    expect(await status(`${metrics}/api/echo`, post({ a: 1 }))).toBe(404)
  })

  it("applies each server's own factory settings", async () => {
    app = twoServers()
    await app.run()
    const { main, admin } = origins()
    const large = { padding: 'x'.repeat(100) }

    expect(await status(`${admin}/admin/echo`, post(large, operator))).toBe(413)
    expect(await status(`${main}/api/echo`, post(large))).toBe(200)
  })

  it('lists every listener by name, in install order, each at an address of its own', async () => {
    app = twoServers()
    await app.run()

    expect([...app.listeners.keys()]).toEqual(['admin', 'metrics'])

    const ports = [app.address!.port, ...[...app.listeners.values()].map(server => server.address!.port)]
    expect(new Set(ports).size).toBe(3)
  })

  it('names on every compiled group the server serving it, for whoever reads the route table', async () => {
    const seen: Array<string | undefined> = []
    app = twoServers({
      adminPlugin: () =>
        fp(async (instance: FastifyInstance) => {
          instance.addHook('onRoute', route => {
            const group = route.config?.$caffeine?.compiled?.group
            if (group !== undefined) {
              seen.push(group.boundTo)
            }
          })
        }),
    })

    await app.bootstrap()

    expect(app.routeGroups.map(group => [group.name, group.boundTo])).toEqual([
      ['Api', undefined],
      ['Admin', 'admin'],
      ['Metrics', 'metrics'],
    ])
    // What a plugin's `onRoute` hook on the listener sees, a GET route's HEAD twin aside.
    expect([...new Set(seen)]).toEqual(['admin'])
  })

  it('stops every server on close', async () => {
    app = twoServers()
    await app.run()
    const servers = [app.instance, ...[...app.listeners.values()].map(server => server.instance)]

    await app.close()

    expect(servers.map(instance => instance.server.listening)).toEqual([false, false, false])
    app = undefined
  })

  it('rejects run() when a listener cannot bind, and leaves nothing listening once closed', async () => {
    const taken: Server = await new Promise(resolve => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => resolve(server))
    })

    try {
      const { port } = taken.address() as { port: number }
      app = twoServers({ metricsPort: port })

      await expect(app.run()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      const servers = [app.instance, ...[...app.listeners.values()].map(server => server.instance)]

      await app.close()

      expect(servers.map(instance => instance.server.listening)).toEqual([false, false, false])
      app = undefined
    } finally {
      await new Promise(resolve => taken.close(resolve))
    }
  })

  it('refuses two listeners of one name', () => {
    expect(() => createWebApplication().install(Listener('admin')).install(Listener('admin'))).toThrow(
      /Cannot install feature "listener:admin": it is already installed/,
    )
  })
})
