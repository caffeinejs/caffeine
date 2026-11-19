import { ErrFeatureNotInstalled } from '@caffeinejs/application'
import { Injectable } from '@caffeinejs/di'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { node } from '../../platform/node.testkit.js'
import type { Guard, GuardInput } from '../guards/guard.js'
import { Guards } from '../guards/guards.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { Authentication } from './auth/auth.js'
import {
  ErrAuthConfiguration,
  ErrAuthenticationCookies,
  ErrAuthenticationGateRequired,
  ErrAuthSchemeNotFound,
} from './auth/errors.js'
import { BaseAuthenticationHandler } from './auth/handler.js'
import { AuthenticateResult, AuthenticationTicket } from './auth/ticket.js'
import { Authorization } from './authz/authz.js'
import { Claim, Identity, Principal } from './identity.js'
import { authentication } from './security.js'

/** Authenticates a request carrying its header, counting every attempt; challenges with its own name. */
class HeaderScheme extends BaseAuthenticationHandler<object> {
  authentications = 0

  constructor(
    private readonly scheme: string,
    private readonly header: string,
  ) {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    this.authentications++
    const user = ctx.req.header(this.header)
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const principal = new Principal(true, [new Identity(this.scheme, true, [new Claim('sub', user, '')])])
    return AuthenticateResult.success(new AuthenticationTicket(principal, this.scheme))
  }

  override async challenge(ctx: IContext): Promise<void> {
    ctx.status(401).header('www-authenticate', this.scheme)
  }
}

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

/** The fetch application with schemes `A` (header `x-a`, the default) and `B` (header `x-b`). */
function gated() {
  const schemeA = new HeaderScheme('A', 'x-a')
  const schemeB = new HeaderScheme('B', 'x-b')
  const built = createWebApplication().install(
    Authentication(a => a.addStrategy('A', schemeA).addStrategy('B', schemeB).default('A')),
  )
  app = built

  return { app: built, schemeA, schemeB }
}

// Any router, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>

function guarded(path: string): AnyRouter {
  return new Router(path)
    .authorize({ roles: [] })
    .get('/')
    .handler(() => 'ok')
}

describe('authentication() on the engine', () => {
  it('refuses a protected route no gate covers', async () => {
    const { app } = gated()
    app.mount(guarded('/p'))

    const err = await app.bootstrap().then(undefined, (e: unknown) => e)

    expect(err).toBeInstanceOf(ErrAuthenticationGateRequired)
    expect((err as Error).message).toContain('"GET|HEAD /p"')
    // The fix offered is one the engine can take: no exemption under a name the package does not export.
    expect((err as Error).message).not.toContain('authenticationExempt')
    expect((err as Error).message).not.toContain('exemptFromAuthentication')
  })

  it('refuses a gate without Authentication installed', async () => {
    const built = createWebApplication().with(authentication())
    app = built

    await expect(built.bootstrap()).rejects.toThrow(ErrFeatureNotInstalled)
  })

  it('challenges a caller with no credential and lets one with a credential through', async () => {
    const { app } = gated()
    app.with(authentication()).mount(guarded('/p'))
    await app.bootstrap()

    const refused = await app.request('/p')
    const passed = await app.request('/p', { headers: { 'x-a': 'alice' } })

    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('A')
    expect(passed.status).toBe(200)
    expect(await passed.text()).toBe('ok')
  })

  it('covers the routes of the router it is on, and only those', async () => {
    const inside = gated()
    inside.app.mount(guarded('/p').with(authentication()))
    await inside.app.bootstrap()

    expect((await inside.app.request('/p', { headers: { 'x-a': 'alice' } })).status).toBe(200)
    await inside.app.close()

    const outside = gated()
    outside.app.mount(guarded('/p').with(authentication()), guarded('/q'))

    await expect(outside.app.bootstrap()).rejects.toThrow('"GET|HEAD /q"')
  })

  // Several gates never authenticate a route twice: the innermost owns it, with its own default scheme.
  it("authenticates a route by the innermost gate alone, with that gate's default scheme", async () => {
    const { app, schemeA } = gated()
    app.with(authentication()).mount(guarded('/admin').with(authentication(g => g.name('admin').defaultScheme('B'))))
    await app.bootstrap()

    const passed = await app.request('/admin', { headers: { 'x-b': 'bob' } })
    expect(passed.status).toBe(200)
    expect(schemeA.authentications).toBe(0)

    const refused = await app.request('/admin', { headers: { 'x-a': 'alice' } })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('B')
  })

  // What a policy protects is a route, and an unknown URL is not one.
  it('answers a URL no route matches with 404, under a fallback policy', async () => {
    const { app } = gated()
    app.install(Authorization(z => z.requireAuthenticatedByDefault())).with(authentication())
    await app.bootstrap()

    expect((await app.request('/nope')).status).toBe(404)
  })

  // A URL no route matches has no route policy, but the caller is still identified, as on Fastify.
  it('authenticates a request no route matches, and authorizes nothing', async () => {
    const seen: boolean[] = []
    const { app } = gated()
    app.with(authentication()).hook('onRequest', ctx => void seen.push(ctx.user.authenticated))
    await app.bootstrap()

    expect((await app.request('/nope', { headers: { 'x-a': 'alice' } })).status).toBe(404)
    expect(seen).toEqual([true])
  })

  it('has established the user by the time the global guards run', async () => {
    const seen: boolean[] = []

    @Injectable()
    class Recorder implements Guard {
      guard(input: GuardInput): boolean {
        seen.push(input.context.user.authenticated)
        return true
      }
    }

    const { app } = gated()
    app
      .install(Guards(g => g.global(Recorder)))
      .with(authentication())
      .mount(new Router('/open').get('/').handler(() => 'ok'))
    await app.bootstrap()

    expect((await app.request('/open', { headers: { 'x-a': 'alice' } })).status).toBe(200)
    expect(seen).toEqual([true])
  })

  // A plugin registered ahead of the gate runs first: what it set goes out on the refusal too.
  it('keeps what a hook registered before it set, on a refusal', async () => {
    const { app } = gated()
    app
      .hook('onRequest', ctx => void ctx.header('x-before', '1'))
      .with(authentication())
      .mount(guarded('/p'))
    await app.bootstrap()

    const refused = await app.request('/p')

    expect(refused.status).toBe(401)
    expect(refused.headers.get('x-before')).toBe('1')
  })

  // What runs after the gate never sees a request the gate refused.
  it('runs no hook registered after it for a refused request', async () => {
    let ran = 0
    const { app } = gated()
    app
      .with(authentication())
      .hook('onRequest', () => void ran++)
      .mount(guarded('/p'))
    await app.bootstrap()

    expect((await app.request('/p')).status).toBe(401)
    expect(ran).toBe(0)
    expect((await app.request('/p', { headers: { 'x-a': 'alice' } })).status).toBe(200)
    expect(ran).toBe(1)
  })

  it('refuses a default scheme no strategy registered', async () => {
    const { app } = gated()
    app.with(authentication(g => g.defaultScheme('Missing')))

    await expect(app.bootstrap()).rejects.toThrow(ErrAuthSchemeNotFound)
  })

  // Every request carrying the session cookie would fail to read it, so the server does not start.
  it('refuses a cookie scheme on a server whose cookies are off', async () => {
    const built = createWebApplication()
      .cookie(k => k.enabled(false))
      .install(
        Authentication(auth => auth.addCookie(c => c.sessionSecret('a-session-secret-of-at-least-32-characters'))),
      )
      .with(authentication())
    app = built

    await expect(built.bootstrap()).rejects.toThrow(ErrAuthenticationCookies)
  })

  describe('two gates under one label', () => {
    it('refuses them in one slot', async () => {
      const { app } = gated()
      app.with(authentication()).with(authentication())

      await expect(app.bootstrap()).rejects.toThrow('Cannot register plugin "caffeine-authentication" twice')
    })

    it('refuses one on a router under one on the application', async () => {
      const { app } = gated()
      app.with(authentication()).mount(guarded('/r').with(authentication()))

      await expect(app.bootstrap()).rejects.toThrow('Cannot register a second authentication gate labelled "default"')
    })

    it('refuses one on a nested router, past a gate of another label', async () => {
      const { app } = gated()
      app
        .with(authentication())
        .mount(
          new Router('/admin')
            .with(authentication(g => g.name('admin')))
            .mount(guarded('/inner').with(authentication())),
        )

      await expect(app.bootstrap()).rejects.toThrow('Cannot register a second authentication gate labelled "default"')
    })
  })
})

describe('OIDC routes on the engine', () => {
  const ISSUER = 'https://oidc-provider.example.com'

  function oidc() {
    return Authentication(auth =>
      auth.addOIDC('Google', opts => {
        opts
          .clientID('oidc-test-client-id')
          .clientSecret('oidc-client-secret')
          .sessionSecret('oidc-integration-test-secret-32ch!!')
          .callbackURL('https://oidc-app.example.com/oidc/callback')
          .authorizationEndpoint(`${ISSUER}/auth`)
          .tokenEndpoint(`${ISSUER}/token`)
          .jwksURI(`${ISSUER}/jwks`)
          .issuer(ISSUER)
      }),
    )
  }

  it('serves the sign-in route from the gate on the application', async () => {
    const built = createWebApplication().install(oidc()).with(authentication())
    app = built
    await built.bootstrap()

    const res = await built.request('/oidc/callback/login?returnTo=/x')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain(`${ISSUER}/auth`)
  })

  it('serves it under the base path', async () => {
    const built = createWebApplication().basePath('/api').install(oidc()).with(authentication())
    app = built
    await built.bootstrap()

    expect((await built.request('/api/oidc/callback/login?returnTo=/x')).status).toBe(302)
  })

  it('refuses a router gate that keeps the routes when no gate on a server claimed them', async () => {
    const built = createWebApplication()
      .install(oidc())
      .with(authentication(g => g.oidcRoutes(false)))
      .mount(
        new Router('/s')
          .with(authentication(g => g.name('scoped')))
          .get('/')
          .handler(() => 'ok'),
      )
    app = built

    const err = await built.bootstrap().then(undefined, (e: unknown) => e)

    expect(err).toBeInstanceOf(ErrAuthConfiguration)
    expect((err as Error).message).toContain('only a gate on a server registers them')
  })

  it('starts a router gate that keeps the routes under the gate on the application that claimed them', async () => {
    const built = createWebApplication()
      .install(oidc())
      .with(authentication())
      .mount(
        new Router('/s')
          .with(authentication(g => g.name('scoped')))
          .get('/')
          .handler(() => 'ok'),
      )
    app = built
    await built.bootstrap()

    expect((await built.request('/s')).status).toBe(200)
    expect((await built.request('/oidc/callback/login?returnTo=/x')).status).toBe(302)
  })

  it('serves them from a listener whose gate is the only one', async () => {
    const built = createWebApplication({ adapter: node() })
      .install(oidc())
      .listener('admin', l => l.with(authentication()))
    app = built
    await built.bootstrap()

    expect((await built.listeners.get('admin')!.request('/oidc/callback/login?returnTo=/x')).status).toBe(302)
    expect((await built.request('/oidc/callback/login?returnTo=/x')).status).toBe(404)
  })
})
