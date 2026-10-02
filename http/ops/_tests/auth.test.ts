import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  Authorization,
  BaseAuthenticationHandler,
  Claim,
  type Context,
  Identity,
  Ops,
  Principal,
  authentication,
  bindTo,
  createWebApplication,
  healthProbes,
  newRouter,
  type WebApplication,
} from '../../index.js'

/**
 * Scenario: an ops server with authentication and authorization.
 *
 * What a route on an ops server requires is what its router declares, exactly as on the application's own server,
 * and only a gate registered on that server authenticates it: the application's own server neither protects its
 * routes nor exposes them. Every request goes over a real socket, to the port the server it targets listens on.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** Authenticates `user[:role,role]` from `header`, as a principal holding those roles. */
class HeaderScheme extends BaseAuthenticationHandler<object> {
  constructor(
    private readonly scheme: string,
    private readonly header: string,
  ) {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const value = ctx.req.header(this.header)
    if (value === undefined) {
      return AuthenticateResult.none()
    }

    const [user, roles = ''] = value.split(':')
    const claims = [
      new Claim('sub', user, ''),
      ...roles
        .split(',')
        .filter(Boolean)
        .map(role => new Claim('roles', role, '')),
    ]

    return AuthenticateResult.success(
      new AuthenticationTicket(new Principal(true, [new Identity(this.scheme, true, claims)]), this.scheme),
    )
  }

  override async challenge(ctx: Context): Promise<void> {
    ctx.status(401).header('x-challenged-by', this.scheme)
  }
}

/** Two schemes: `App`, the application default, from `x-app`, and `Ops` from `x-ops`. */
const schemes = () =>
  Authentication(a =>
    a
      .addStrategy('App', new HeaderScheme('App', 'x-app'))
      .addStrategy('Ops', new HeaderScheme('Ops', 'x-ops'))
      .default('App'),
  )

const metrics = () =>
  newRouter('/metrics')
    .with(bindTo('admin'))
    .get('/', () => ({ metrics: true }))

/** `/metrics`, bound to `admin`, for an `Ops` operator alone. */
const protectedMetrics = () =>
  newRouter('/metrics')
    .with(bindTo('admin'))
    .authorize({ schemes: ['Ops'], roles: ['operator'] })
    .get('/', () => ({ metrics: true }))

const api = () => newRouter('/api').get('/', () => ({ api: true }))

describe('an ops server with authentication and authorization', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function status(origin: string, path: string, headers?: Record<string, string>): Promise<number> {
    return (await fetch(`${origin}${path}`, { headers })).status
  }

  function opsOrigin(name = 'admin'): string {
    return app!.ops.get(name)!.address!.origin
  }

  it("answers 401, 403 and 200 under its router's scheme and roles, while the application server stays open", async () => {
    app = createWebApplication()
      .install(schemes())
      .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication())))
      .server(() => ({ listener }))
      .mount(protectedMetrics(), api()) as WebApplication

    await app.run()

    expect(await status(opsOrigin(), '/metrics')).toBe(401)
    expect(await status(opsOrigin(), '/metrics', { 'x-ops': 'bob:viewer' })).toBe(403)
    expect(await status(opsOrigin(), '/metrics', { 'x-ops': 'alice:operator' })).toBe(200)
    // The router names its scheme, so the application default authenticates nobody there.
    expect(await status(opsOrigin(), '/metrics', { 'x-app': 'alice:operator' })).toBe(401)

    // Neither server serves the other's routes, and the application's own needs nothing.
    expect(await status(app.address!.origin, '/api')).toBe(200)
    expect(await status(app.address!.origin, '/metrics')).toBe(404)
    expect(await status(opsOrigin(), '/api', { 'x-ops': 'alice:operator' })).toBe(404)
  })

  it("reaches undeclared ops routes with the application's fallback policy", async () => {
    app = createWebApplication()
      .install(schemes())
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication())))
      .with(authentication())
      .server(() => ({ listener }))
      .mount(metrics(), api()) as WebApplication

    await app.run()

    expect(await status(opsOrigin(), '/metrics')).toBe(401)
    expect(await status(opsOrigin(), '/metrics', { 'x-app': 'alice' })).toBe(200)
    expect(await status(app.address!.origin, '/api')).toBe(401)
  })

  // A route a plugin registers on the server directly compiles nothing: it answers to the fallback policy, as it
  // would on the application's own server, and a health probe's is exempt.
  it('holds a route a plugin registers straight on the server to the fallback policy, health probes aside', async () => {
    const raw = () => async (instance: FastifyInstance) => {
      instance.get('/raw', async () => ({ raw: true }))
    }

    app = createWebApplication()
      .install(schemes())
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .install(
        Ops('admin', o =>
          o
            .server(() => ({ listener }))
            .with(authentication())
            .with(healthProbes())
            .with(raw),
        ),
      ) as WebApplication

    await app.run()

    expect(await status(opsOrigin(), '/raw')).toBe(401)
    expect(await status(opsOrigin(), '/raw', { 'x-app': 'alice' })).toBe(200)
    expect(await status(opsOrigin(), '/livez')).toBe(200)
  })

  // A gate covers the routes of the server it was registered on, and only those.
  describe('without a gate on the server', () => {
    it('refuses a protected route at start-up, naming the route and the fix', async () => {
      app = createWebApplication()
        .install(schemes())
        .install(Ops('admin', o => o.server(() => ({ listener }))))
        .mount(protectedMetrics(), api()) as WebApplication

      const error = await app.bootstrap().catch((error: unknown) => error)

      expect(error).toMatchObject({ code: 'ERR_AUTHENTICATION_GATE_REQUIRED' })
      expect((error as Error).message).toContain('/metrics')
      expect((error as Error).message).toContain('Ops(name, o => o.with(authentication()))')
    })

    it("refuses it with the application's own server gated", async () => {
      app = createWebApplication()
        .install(schemes())
        .install(Ops('admin', o => o.server(() => ({ listener }))))
        .with(authentication())
        .mount(protectedMetrics(), api()) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTHENTICATION_GATE_REQUIRED' })
    })

    it('refuses an undeclared route the fallback policy reaches', async () => {
      app = createWebApplication()
        .install(schemes())
        .install(Authorization(z => z.requireAuthenticatedByDefault()))
        .install(Ops('admin', o => o.server(() => ({ listener }))))
        .with(authentication())
        .mount(metrics(), api()) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTHENTICATION_GATE_REQUIRED' })
    })
  })

  describe('OIDC', () => {
    const oidc = () =>
      Authentication(auth =>
        auth.addOIDC('Google', opts =>
          opts
            .clientID('ops-client')
            .clientSecret('ops-client-secret')
            .sessionSecret('ops-oidc-test-session-secret-32ch!')
            .callbackURL('https://app.example.com/oidc/callback')
            .authorizationEndpoint('https://idp.example.com/auth')
            .tokenEndpoint('https://idp.example.com/token')
            .jwksURI('https://idp.example.com/jwks')
            .issuer('https://idp.example.com'),
        ),
      )

    // The routes register once, on the first gate to install, and the application's own server is built first.
    it("serves the login callback from the application's own gate, and not from the ops server's", async () => {
      app = createWebApplication()
        .install(oidc())
        .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication())))
        .with(authentication())
        .server(() => ({ listener }))
        .mount(metrics()) as WebApplication

      await app.run()

      expect(await status(app.address!.origin, '/oidc/callback')).not.toBe(404)
      expect(await status(opsOrigin(), '/oidc/callback')).toBe(404)
    })

    it("serves the login callback from an ops server's gate when it is the only one", async () => {
      app = createWebApplication()
        .install(oidc())
        .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication())))
        .server(() => ({ listener }))
        .mount(metrics()) as WebApplication

      await app.run()

      expect(await status(opsOrigin(), '/oidc/callback')).not.toBe(404)
      expect(await status(app.address!.origin, '/oidc/callback')).toBe(404)
    })

    it('keeps the login callback off an ops server whose gate turns the OIDC routes off', async () => {
      app = createWebApplication()
        .install(oidc())
        .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication(g => g.oidcRoutes(false)))))
        .mount(metrics()) as WebApplication

      await app.run()

      expect(await status(opsOrigin(), '/oidc/callback')).toBe(404)
    })
  })

  describe('refusals at start-up', () => {
    it('refuses a protected route with authentication never installed', async () => {
      app = createWebApplication()
        .install(Ops('admin', o => o.server(() => ({ listener }))))
        .mount(protectedMetrics()) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTHENTICATION_REQUIRED' })
    })

    it('refuses a gate on a server with authentication never installed', async () => {
      app = createWebApplication()
        .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication())))
        .mount(metrics()) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_FEATURE_NOT_INSTALLED',
        message: expect.stringMatching(/Cannot use feature "auth"/),
      })
    })

    it('refuses a route naming a scheme nothing registered', async () => {
      app = createWebApplication()
        .install(schemes())
        .install(Ops('admin', o => o.server(() => ({ listener })).with(authentication())))
        .mount(
          newRouter('/metrics')
            .with(bindTo('admin'))
            .authorize({ schemes: ['Missing'] })
            .get('/', () => ({ metrics: true })),
        ) as WebApplication

      await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTH_SCHEME_NOT_FOUND' })
    })
  })
})
