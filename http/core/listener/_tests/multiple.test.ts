import { createServer, type Server } from 'node:net'

import { Byte } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  type IContext,
  Identity,
  Principal,
  HTTPPlugin,
  type HTTPPluginFactory,
  type HTTPSetupContext,
  bindTo,
  Router,
} from '../../../index.js'
import { createWebApplication, type NodeWebApplication } from '../../../platform/node/index.js'
import { healthProbes } from '../../health/index.js'
import { authentication } from '../../security/security.js'

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

/** Collects the server each route group is bound to, as every route registers. */
class Recording extends HTTPPlugin {
  constructor(private readonly seen: Array<string | undefined>) {
    super()
  }

  register({ app }: HTTPSetupContext): void {
    app.hook('onRoute', route => {
      if (route.group.boundTo !== undefined) {
        this.seen.push(route.group.boundTo)
      }
    })
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
    .listener('admin', l => {
      l.server(() => ({ bodyLimit: 64 * Byte, listen: listener })).with(authentication())

      if (adminPlugin !== undefined) {
        l.with(adminPlugin)
      }
    })
    .listener('metrics', l => l.server(() => ({ listen: { ...listener, port: metricsPort } })).with(healthProbes()))
    .server(() => ({ listen: listener }))
    .mount(
      new Router('/admin')
        .extend(bindTo('admin'))
        .authorize({ schemes: ['Ops'], roles: ['operator'] })
        .post('/echo', ctx => ({ received: ctx.req.body() })),
      new Router('/metrics').extend(bindTo('metrics')).get('/', () => ({ up: true })),
      new Router('/api').post('/echo', ctx => ({ received: ctx.req.body() })),
    ) as NodeWebApplication
}

describe('several listeners with different settings', () => {
  let app: NodeWebApplication | undefined

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
      adminPlugin: () => new Recording(seen),
    })

    await app.bootstrap()

    expect(app.routeGroups.map(group => [group.name, group.boundTo])).toEqual([
      ['Api', undefined],
      ['Admin', 'admin'],
      ['Metrics', 'metrics'],
    ])
    // What a plugin's `onRoute` hook on the listener sees.
    expect([...new Set(seen)]).toEqual(['admin'])
  })

  it('stops every server on close', async () => {
    app = twoServers()
    await app.run()
    const servers = [app.instance, ...[...app.listeners.values()].map(server => server.instance)]

    await app.close()

    expect(servers.map(instance => instance.listening)).toEqual([false, false, false])
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

      expect(servers.map(instance => instance.listening)).toEqual([false, false, false])
      app = undefined
    } finally {
      await new Promise(resolve => taken.close(resolve))
    }
  })

  it('refuses two listeners of one name', () => {
    const twice = () => createWebApplication().listener('admin').listener('admin')

    expect(twice).toThrow(expect.objectContaining({ name: 'ErrConfiguration', code: 'ERR_CONFIGURATION' }))
    expect(twice).toThrow(/^Cannot add listener "admin": a listener named "admin" is already added/)
  })
})
