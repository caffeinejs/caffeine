import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  BaseAuthenticationHandler,
  Ops,
  authentication,
  bindTo,
  createWebApplication,
  healthProbes,
  newRouter,
  type WebApplication,
} from '../../index.js'

/**
 * Health probes on an ops server. The probes know nothing about servers: registered on one with `o.with(...)`, they
 * are raw routes there, exempt from authentication, and a server that did not register them does not serve them.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** Authenticates nobody, so any protected route answers 401. */
class NobodyScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

describe('health probes on an ops server', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = undefined
  })

  async function status(origin: string, path: string): Promise<number> {
    return (await fetch(`${origin}${path}`)).status
  }

  it("serves the three probes on the server that registered them, and not on the application's own", async () => {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener })).with(healthProbes())))
      .server(() => ({ listener })) as WebApplication

    await app.run()
    const ops = app.ops.get('admin')!.address!.origin

    for (const probe of ['/livez', '/readyz', '/startupz']) {
      expect(await status(ops, probe)).toBe(200)
      expect(await status(app.address!.origin, probe)).toBe(404)
    }
  })

  // One factory, called once per server: registering it on an ops server takes nothing from the application's own.
  it('serves them on both servers when both registered them', async () => {
    const probes = healthProbes()

    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener })).with(probes)))
      .with(probes)
      .server(() => ({ listener })) as WebApplication

    await app.run()

    expect(await status(app.ops.get('admin')!.address!.origin, '/readyz')).toBe(200)
    expect(await status(app.address!.origin, '/readyz')).toBe(200)
  })

  it('stays exempt from the authorization of the server serving it', async () => {
    app = createWebApplication()
      .install(Authentication(a => a.addStrategy('Nobody', new NobodyScheme()).default('Nobody')))
      .install(
        Ops('admin', o =>
          o
            .server(() => ({ listener }))
            .with(authentication())
            .with(healthProbes())
            .authorize({ roles: ['operator'] }),
        ),
      )
      .mount(
        newRouter('/jobs')
          .with(bindTo('admin'))
          .get('/', () => ({})),
      ) as WebApplication

    await app.run()
    const ops = app.ops.get('admin')!.address!.origin

    expect(await status(ops, '/readyz')).toBe(200)
    expect(await status(ops, '/jobs')).toBe(401)
  })

  it('checks probe paths only against the routes of the server serving them', async () => {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener })).with(healthProbes())))
      .server(() => ({ listener }))
      .mount(newRouter().get('/livez', () => ({ mine: true }))) as WebApplication

    await app.run()

    expect(await (await fetch(`${app.address!.origin}/livez`)).json()).toEqual({ mine: true })
    expect(await status(app.ops.get('admin')!.address!.origin, '/livez')).toBe(200)
  })

  it('refuses a route of the server serving the probes that takes a probe path', async () => {
    app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener })).with(healthProbes())))
      .mount(
        newRouter()
          .with(bindTo('admin'))
          .get('/readyz', () => ({})),
      ) as WebApplication

    await expect(app.bootstrap()).rejects.toThrow(/already registered at "\/readyz"/)
  })
})
