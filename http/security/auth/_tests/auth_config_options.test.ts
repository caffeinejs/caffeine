import { CaffeineIoC, token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import FastifyCookie from '@fastify/cookie'
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
  instance.register(FastifyCookie)

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
          a.config(c.auth).addOAuth2('oauth', o =>
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
          a.config(c.auth).addOIDC('oidc', o =>
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
      a.config(c.auth).addOAuth2('oauth', o =>
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
