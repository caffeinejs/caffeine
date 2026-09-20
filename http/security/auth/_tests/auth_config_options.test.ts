import { CaffeineIoC, token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AuthenticationService,
  AuthenticationTicket,
  Claim,
  type CredentialUser,
  CredentialsService,
  ErrRefreshTokenRejected,
  Identity,
  PasswordHasher,
  Principal,
  RefreshTokenService,
  RefreshTokenStore,
  RememberMeTokenStore,
  ScryptPasswordHasher,
  type SeriesTokenRecord,
  type SeriesTokenRotation,
  UserProvider,
  authConfigSchema,
  createWebApplication,
  fastifyAdapterFactory,
  newRouter,
} from '../../../index.js'

/**
 * Options that reach a scheme from the configuration tree and from nowhere else in these tests.
 *
 * Each is observed doing what it says, not merely arriving: a key wired to the wrong setter validates, applies,
 * and leaves the deployment running on a default its operator believes was changed.
 */

const schema = $t.Object({ auth: $t.Object({ ...authConfigSchema.properties }, { default: {} }) })
const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config.options'))

const SESSION_SECRET = 'a-perfectly-long-session-secret-value!!'
const JWT_SECRET = 'a-jwt-secret-that-is-at-least-32-bytes!!'

const configured = (auth: Record<string, unknown>) =>
  newConfiguration(schema, kConfig).source(new InlineConfigSource({ auth })).build()

function server() {
  const instance = fastify({ logger: false })

  return instance
}

const ada = () => new Principal(true, new Identity('test', true, [new Claim('sub', 'ada', '')]))

class SeriesStore {
  readonly records = new Map<string, SeriesTokenRecord>()

  create(record: SeriesTokenRecord): void {
    this.records.set(record.series, { ...record })
  }

  findBySeries(series: string): SeriesTokenRecord | null {
    const record = this.records.get(series)
    return record === undefined ? null : { ...record }
  }

  rotate(series: string, expectedTokenHash: string, rotation: SeriesTokenRotation): boolean {
    const record = this.records.get(series)
    if (record === undefined || record.tokenHash !== expectedTokenHash) {
      return false
    }

    Object.assign(record, rotation)
    return true
  }

  remove(series: string): void {
    this.records.delete(series)
  }

  removeBySubject(): void {}
}

/** The scheme's own part of an OAuth-family registration: everything a tree would not carry in these tests. */
const provider = {
  clientID: 'client',
  clientSecret: 'client-secret',
  authorizationEndpoint: 'https://provider.test/authorize',
  tokenEndpoint: 'https://provider.test/token',
  userInfoEndpoint: 'https://provider.test/userinfo',
  callbackURL: 'https://app.test/auth/callback',
}

const asScript = { headers: { accept: 'application/json' } }

describe('authentication options set from the tree', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // Used every day, a remember-me credential renews itself for good. The absolute lifetime is the only thing that
  // ends it, so one that is configured and not applied is a credential that never expires.
  it('caps the life of a remember-me credential at `rememberMeAbsoluteMaxAge`', async () => {
    const store = new SeriesStore()
    const container = new CaffeineIoC()
    container.bind(RememberMeTokenStore, t => t.toValue(store as unknown as RememberMeTokenStore))
    // Reloads the user when a session is restored. Nothing is restored here, but the scheme wants one bound.
    container.bind(UserProvider, t => t.toValue({ findByIdentifier: () => null } as unknown as UserProvider))

    const app = createWebApplication(fastifyAdapterFactory(server()), {
      container,
      config: configured({ schemes: { Cookie: { rememberMeAbsoluteMaxAge: 3600 } } }),
    })
      .authentication((a, c) =>
        a.config(c.auth).addCookie(b => b.sessionSecret(SESSION_SECRET).secure(false).rememberMe()),
      )
      .mount(
        newRouter('/session')
          .authorize({ allowAnonymous: true })
          .inject({ auth: AuthenticationService })
          .post('/', async (ctx, { auth }) => {
            await auth.persist(ctx, 'Cookie', new AuthenticationTicket(ada(), 'Cookie', { isPersistent: true }))
            return { ok: true }
          }),
      )
    await app.ready()

    const signedIn = await app.fetch('/session', { method: 'POST' })
    expect(signedIn.status).toBe(200)

    const [record] = [...store.records.values()]
    // An hour, where the idle lifetime alone would have given it thirty days.
    expect(record.expiresAt - record.createdAt).toBe(3600)

    // And it is the cap that did it, not the idle lifetime having been set to an hour: the cookie still asks the
    // browser for the thirty days.
    const remember = signedIn.headers.getSetCookie().find(line => line.startsWith('caf.remember='))
    expect(remember).toContain(`Max-Age=${30 * 24 * 60 * 60}`)

    await app.close()
  })

  describe('the sign-in path of an OAuth-family scheme', () => {
    const protectedRoute = newRouter('/reports')
      .authorize({})
      .get('/', () => ({ ok: true }))

    // The 401 names it and the route answers there. Were the key applied to nothing, a client would be sent to a
    // URL that was never registered.
    it('is where an OAuth 2.0 scheme sends a script, and where it starts the sign-in', async () => {
      const app = createWebApplication(fastifyAdapterFactory(server()), {
        config: configured({ schemes: { oauth: { loginPath: '/start' } } }),
      })
        .authentication((a, c) =>
          a
            .config(c.auth)
            .addOAuth2('oauth', o =>
              o
                .clientID(provider.clientID)
                .clientSecret(provider.clientSecret)
                .sessionSecret(SESSION_SECRET)
                .authorizationEndpoint(provider.authorizationEndpoint)
                .tokenEndpoint(provider.tokenEndpoint)
                .userInfoEndpoint(provider.userInfoEndpoint)
                .callbackURL(provider.callbackURL),
            ),
        )
        .mount(protectedRoute)
      await app.ready()

      const challenged = await app.fetch('/reports', asScript)
      expect(challenged.status).toBe(401)
      expect(((await challenged.json()) as { loginURL: string }).loginURL).toBe(
        'https://app.test/start?returnTo=%2Freports',
      )

      const started = await app.fetch('/start?returnTo=%2Freports', { redirect: 'manual' })
      expect(started.status).toBe(302)
      expect(new URL(started.headers.get('location')!).origin).toBe('https://provider.test')

      // The default it replaces is not left behind as a second way in.
      expect((await app.fetch('/auth/callback/login', { redirect: 'manual' })).status).toBe(404)

      await app.close()
    })

    it('is where an OpenID Connect scheme sends a script', async () => {
      const app = createWebApplication(fastifyAdapterFactory(server()), {
        config: configured({ schemes: { oidc: { loginPath: '/oidc/start' } } }),
      })
        .authentication((a, c) =>
          a
            .config(c.auth)
            .addOIDC('oidc', o =>
              o
                .clientID(provider.clientID)
                .clientSecret(provider.clientSecret)
                .sessionSecret(SESSION_SECRET)
                .issuer('https://provider.test')
                .discoveryURL('https://provider.test/.well-known/openid-configuration')
                .callbackURL(provider.callbackURL),
            ),
        )
        .mount(protectedRoute)
      await app.ready()

      // A challenge that cannot redirect asks the provider nothing, so this is answered with no provider at all.
      const challenged = await app.fetch('/reports', asScript)
      expect(challenged.status).toBe(401)
      expect(((await challenged.json()) as { loginURL: string }).loginURL).toBe(
        'https://app.test/oidc/start?returnTo=%2Freports',
      )

      await app.close()
    })
  })

  /**
   * A deployment names its provider in the tree because the provider differs per environment. The wrong
   * `client_id` runs the flow under a registration that is not this application's, and the wrong `redirect_uri`
   * has the authorization code delivered to a URL it does not serve.
   */
  describe('an OpenID Connect provider the tree names', () => {
    const DISCOVERY_URL = 'https://provider.test/.well-known/openid-configuration'
    const ISSUER = 'https://provider.test'
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      // The downgrade alone, so the provider cannot be reached at all without `allowPlainPkce`.
      code_challenge_methods_supported: ['plain'],
    }

    const asNavigation = { headers: { 'sec-fetch-mode': 'navigate' }, redirect: 'manual' as const }

    const protectedRoute = newRouter('/reports')
      .authorize({})
      .get('/', () => ({ ok: true }))

    function discovered() {
      const fetched = vi.fn((url: string) => {
        if (url === DISCOVERY_URL) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(discovery) })
        }

        return Promise.reject(new Error(`the provider was asked for ${url}`))
      })
      vi.stubGlobal('fetch', fetched)

      return fetched
    }

    const appWith = (oidc: Record<string, unknown>) =>
      createWebApplication(fastifyAdapterFactory(server()), { config: configured({ schemes: { oidc } }) })
        .authentication((a, c) =>
          a
            .config(c.auth)
            .addOIDC('oidc', o => o.clientSecret(provider.clientSecret).sessionSecret(SESSION_SECRET).issuer(ISSUER)),
        )
        .mount(protectedRoute)

    it('asks that provider, under that client, to come back to that callback', async () => {
      const fetched = discovered()
      const app = appWith({
        clientId: 'from-tree',
        discoveryUrl: DISCOVERY_URL,
        callbackUrl: 'https://app.test/signin/back',
        allowPlainPkce: true,
      })
      await app.ready()

      const challenged = await app.fetch('/reports', asNavigation)
      expect(challenged.status).toBe(302)

      const authorization = new URL(challenged.headers.get('location')!)
      expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`)
      expect(authorization.searchParams.get('client_id')).toBe('from-tree')
      expect(authorization.searchParams.get('redirect_uri')).toBe('https://app.test/signin/back')

      // The document that named the endpoint was fetched from the URL the tree gave, and from nowhere else.
      expect(fetched.mock.calls.map(([url]) => url)).toEqual([DISCOVERY_URL])

      await app.close()
    })

    // Plain PKCE gives up the protection a code interception attack is stopped by, so it is taken only where
    // an operator asked for it. Applied to nothing, the application would accept the downgrade unasked.
    it('takes the plain PKCE downgrade only where the tree asked for it', async () => {
      discovered()
      const app = appWith({
        clientId: 'from-tree',
        discoveryUrl: DISCOVERY_URL,
        callbackUrl: 'https://app.test/signin/back',
        allowPlainPkce: true,
      })
      await app.ready()

      const challenged = await app.fetch('/reports', asNavigation)
      expect(new URL(challenged.headers.get('location')!).searchParams.get('code_challenge_method')).toBe('plain')

      await app.close()

      discovered()
      const strict = appWith({
        clientId: 'from-tree',
        discoveryUrl: DISCOVERY_URL,
        callbackUrl: 'https://app.test/signin/back',
      })
      await strict.ready()

      const refused = await strict.fetch('/reports', asNavigation)
      expect(refused.status).toBe(500)
      expect(refused.headers.get('location')).toBeNull()

      await strict.close()
    })

    // Without discovery the JWKS URI is the only place the keys that id_tokens are verified against come from,
    // and the options refuse to resolve without it rather than leave a scheme that cannot verify anything.
    it('completes a hand-assembled provider that has no discovery document', async () => {
      const manual = (oidc: Record<string, unknown>) =>
        createWebApplication(fastifyAdapterFactory(server()), { config: configured({ schemes: { oidc } }) })
          .authentication((a, c) =>
            a
              .config(c.auth)
              .addOIDC('oidc', o =>
                o
                  .clientID('code-client')
                  .clientSecret(provider.clientSecret)
                  .sessionSecret(SESSION_SECRET)
                  .issuer(ISSUER)
                  .authorizationEndpoint(`${ISSUER}/authorize`)
                  .tokenEndpoint(`${ISSUER}/token`)
                  .callbackURL('https://app.test/signin/back'),
              ),
          )
          .mount(protectedRoute)

      await expect(manual({}).ready()).rejects.toThrow(/provide discoveryURL or all of/)

      const app = manual({ jwksUri: `${ISSUER}/jwks` })
      await app.ready()

      // And it is the JWKS URI it completed, not some other endpoint: the authorization request still goes to
      // the endpoint the code named.
      const challenged = await app.fetch('/reports', asNavigation)
      const authorization = new URL(challenged.headers.get('location')!)
      expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`)

      await app.close()
    })

    // The provider validates this against the registration and refuses to return the user anywhere else, so an
    // application whose configured value never arrives strands every sign-out on the provider's own page.
    it('asks the provider to return the user to `postLogoutRedirectUri` after a sign-out', async () => {
      const app = createWebApplication(fastifyAdapterFactory(server()), {
        config: configured({ schemes: { oidc: { postLogoutRedirectUri: 'https://app.test/signed-out' } } }),
      })
        .authentication((a, c) =>
          a
            .config(c.auth)
            .addOIDC('oidc', o =>
              o
                .clientID('code-client')
                .clientSecret(provider.clientSecret)
                .sessionSecret(SESSION_SECRET)
                .issuer(ISSUER)
                .authorizationEndpoint(`${ISSUER}/authorize`)
                .tokenEndpoint(`${ISSUER}/token`)
                .jwksURI(`${ISSUER}/jwks`)
                .endSessionEndpoint(`${ISSUER}/logout`)
                .callbackURL('https://app.test/signin/back'),
            ),
        )
        .mount(
          newRouter('/session')
            .authorize({ allowAnonymous: true })
            .inject({ auth: AuthenticationService })
            .post('/out', (ctx, { auth }) => auth.signOut(ctx, 'oidc')),
        )
      await app.ready()

      const out = await app.fetch('/session/out', { method: 'POST', redirect: 'manual' })
      expect(out.status).toBe(302)

      const logout = new URL(out.headers.get('location')!)
      expect(logout.origin + logout.pathname).toBe(`${ISSUER}/logout`)
      expect(logout.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/signed-out')

      await app.close()
    })
  })

  // The login page reads the way back under the name it was written under. Applied to nothing, a deep link is
  // lost on every sign-in and the user lands on the application root instead.
  it('carries the way back on the query parameter `returnUrlParameter` names', async () => {
    const container = new CaffeineIoC()
    container.bind(UserProvider, t => t.toValue({ findByIdentifier: () => null } as unknown as UserProvider))

    const app = createWebApplication(fastifyAdapterFactory(server()), {
      container,
      config: configured({ schemes: { Cookie: { returnUrlParameter: 'next' } } }),
    })
      .authentication((a, c) =>
        a.config(c.auth).addCookie(b => b.sessionSecret(SESSION_SECRET).secure(false).loginPath('/login')),
      )
      .mount(
        newRouter('/reports')
          .authorize({})
          .get('/', () => ({ ok: true })),
      )
    await app.ready()

    const challenged = await app.fetch('/reports', {
      headers: { 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    })

    expect(challenged.status).toBe(302)
    expect(challenged.headers.get('location')).toBe(`/login?next=${encodeURIComponent('/reports')}`)

    await app.close()
  })

  // RFC 6749 §2.3.1 recommends against the secret in the request body. An operator who configured the header and
  // got the body has the secret in every proxy log between here and the provider.
  it('sends the client secret to the token endpoint the way `tokenEndpointAuthMethod` says', async () => {
    const tokenRequests: Array<{ headers: Record<string, string>; body: URLSearchParams }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === provider.tokenEndpoint) {
          tokenRequests.push({ headers: init?.headers as Record<string, string>, body: init?.body as URLSearchParams })
          return { ok: true, status: 200, json: () => Promise.resolve({ access_token: 'at', token_type: 'Bearer' }) }
        }

        return { ok: true, status: 200, json: () => Promise.resolve({ id: 'u1' }) }
      }),
    )

    const app = createWebApplication(fastifyAdapterFactory(server()), {
      config: configured({ schemes: { oauth: { tokenEndpointAuthMethod: 'client_secret_basic' } } }),
    }).authentication((a, c) =>
      a
        .config(c.auth)
        .addOAuth2('oauth', o =>
          o
            .clientID(provider.clientID)
            .clientSecret(provider.clientSecret)
            .sessionSecret(SESSION_SECRET)
            .authorizationEndpoint(provider.authorizationEndpoint)
            .tokenEndpoint(provider.tokenEndpoint)
            .userInfoEndpoint(provider.userInfoEndpoint)
            .subjectClaim('id')
            .callbackURL(provider.callbackURL),
        ),
    )
    await app.ready()

    // A whole round trip: the sign-in route hands out the state and its cookie, the callback spends them.
    const started = await app.fetch('/auth/callback/login', { redirect: 'manual' })
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!
    const cookie = started.headers
      .getSetCookie()
      .map(line => line.split(';')[0])
      .join('; ')

    const back = await app.fetch(`/auth/callback?code=c&state=${state}`, { headers: { cookie }, redirect: 'manual' })
    expect(back.status).toBe(302)

    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(`${provider.clientID}:${provider.clientSecret}`).toString('base64')}`,
    )
    expect(tokenRequests[0].body.has('client_secret')).toBe(false)

    await app.close()
  })

  // Every refresh pushes the idle lifetime back, so a client that keeps refreshing does so for ever. The absolute
  // lifetime is what makes it sign in again.
  it('ends a refresh token family at `refresh.absoluteTtl`, however recently it was used', async () => {
    const store = new SeriesStore()
    const container = new CaffeineIoC()
    container.bind(RefreshTokenStore, t => t.toValue(store as unknown as RefreshTokenStore))

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      container,
      config: configured({ refresh: { absoluteTtl: 60, refreshTtl: '30d' } }),
    }).authentication((a, c) =>
      a
        .config(c.auth)
        .addJWTBearer(b => b.secret(JWT_SECRET).issuer('local').audience('local'))
        .addRefreshTokens(o => o.resolve(() => ada())),
    )
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const service = app.container.get(RefreshTokenService)
    const issued = await service.issue(ada())

    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    const refreshed = await service.refresh(issued.refreshToken)

    // Used thirty seconds ago, and still a minute old at most.
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    await expect(service.refresh(refreshed.refreshToken)).rejects.toBeInstanceOf(ErrRefreshTokenRejected)

    await app.close()
  })

  // The access token is the credential that is replayed on every request and cannot be revoked before it
  // expires, so its lifetime is the window a stolen one stays good. Configured short and applied to nothing, a
  // deployment runs on the default while believing the window was closed.
  it('mints an access token that lives for `refresh.accessTtl` and no longer', async () => {
    const container = new CaffeineIoC()
    container.bind(RefreshTokenStore, t => t.toValue(new SeriesStore() as unknown as RefreshTokenStore))

    const app = createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
      container,
      config: configured({ refresh: { accessTtl: 60 } }),
    })
      .authentication((a, c) =>
        a
          .config(c.auth)
          .addJWTBearer(b => b.secret(JWT_SECRET).issuer('local').audience('local'))
          .addRefreshTokens(o => o.resolve(() => ada())),
      )
      .mount(
        newRouter('/reports')
          .authorize({})
          .get('/', () => ({ ok: true })),
      )
    await app.ready()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { accessToken } = await app.container.get(RefreshTokenService).issue(ada())
    const asBearer = { headers: { authorization: `Bearer ${accessToken}` } }

    expect((await app.fetch('/reports', asBearer)).status).toBe(200)

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    expect((await app.fetch('/reports', asBearer)).status).toBe(401)

    await app.close()
  })

  describe('the credentials block', () => {
    class Users extends UserProvider {
      constructor(private readonly passwordHash: string) {
        super()
      }

      findByIdentifier(): CredentialUser {
        return { id: 'ada', passwordHash: this.passwordHash, claims: [new Claim('groups', 'admin', '')] }
      }
    }

    const hasher = new ScryptPasswordHasher({ N: 1024 })

    function credentialsApp(credentials: Record<string, unknown>, passwordHash = '') {
      const container = new CaffeineIoC()
      container.bind(UserProvider, t => t.toValue(new Users(passwordHash)))
      container.bind(PasswordHasher, t => t.toValue(hasher))

      return createWebApplication(fastifyAdapterFactory(fastify({ logger: false })), {
        container,
        config: configured({ credentials }),
      }).authentication((a, c) =>
        a
          .config(c.auth)
          .addJWTBearer(b => b.secret(JWT_SECRET).issuer('local').audience('local'))
          .addCredentials({ scheme: 'FromCode' }),
      )
    }

    // The role claim type decides what `isInRole` reads. Configured and not applied, every role check of a
    // password sign-in reads a claim the users do not carry.
    it('names the identity and its role claim the way the tree says, over what the code said', async () => {
      const app = credentialsApp({ scheme: 'FromTree', roleClaimType: 'groups' }, await hasher.hash('s3cret'))
      await app.ready()

      const principal = await app.container.get(CredentialsService).attempt('ada', 's3cret')

      expect(principal?.identities[0].authenticationType).toBe('FromTree')
      expect(principal?.isInRole('admin')).toBe(true)

      await app.close()
    })
  })
})
