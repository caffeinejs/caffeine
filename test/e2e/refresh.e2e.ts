import { randomUUID } from 'node:crypto'

import { CaffeineIoC } from '@caffeinejs/di'
import {
  Claim,
  type CredentialUser,
  CredentialsService,
  Identity,
  PasswordHasher,
  Principal,
  RefreshTokenService,
  RefreshTokenStore,
  ScryptPasswordHasher,
  UserProvider,
  newRouter,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type BrowserResponse } from './internal/browser/index.js'
import { reachable } from './internal/redis/index.js'
import { REDIS_URL, RedisRefreshTokenStore, connectRedis, type RedisClient } from './internal/redis/stores.js'
import { required } from './internal/strict.js'
import { localJWT } from './internal/tokens.js'

/**
 * The bearer refresh-token grant, with the tokens held in Redis: a short-lived access token, and a refresh token
 * that is good once. What a client does with a token it has is not the server's to trust, so the cases that matter
 * are the ones where a token is presented twice.
 */

interface Pair {
  accessToken: string
  refreshToken: string
}

const hasher = new ScryptPasswordHasher({ N: 1024 })
const users = new Map<string, CredentialUser>()

class Users extends UserProvider {
  findByIdentifier(identifier: string): CredentialUser | null {
    return users.get(identifier) ?? null
  }
}

function principalOf(subject: string): Principal | null {
  const user = users.get(subject)

  return user === undefined
    ? null
    : new Principal(true, new Identity('Refresh', true, [new Claim('sub', user.id, ''), ...(user.claims ?? [])]))
}

function routes() {
  const tokens = newRouter('/token')
    .inject({ credentials: CredentialsService, refresh: RefreshTokenService })
    .post('/', async (ctx, { credentials, refresh }) => {
      const body = ctx.req.body() as { identifier: string; password: string }
      const principal = await credentials.attempt(body.identifier, body.password)

      if (principal === null) {
        ctx.status(401)
        return { ok: false }
      }

      return refresh.issue(principal)
    })
    .post('/refresh', (ctx, { refresh }) => refresh.refresh((ctx.req.body() as { refreshToken: string }).refreshToken))
    .post('/revoke', async (ctx, { refresh }) => {
      await refresh.revoke((ctx.req.body() as { refreshToken: string }).refreshToken)
      return { ok: true }
    })

  const account = newRouter('/account')
    .authorize({})
    .inject({ refresh: RefreshTokenService })
    .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value, roles: ctx.user.findFirst('roles')?.value }))
    .post('/sign-out-everywhere', async (ctx, { refresh }) => {
      await refresh.revokeAllForSubject(String(ctx.user.findFirst('sub')?.value))
      return { ok: true }
    })

  return newRouter().mount(tokens, account)
}

const up = required('redis', await reachable(REDIS_URL))

describe.skipIf(!up)('refresh tokens held in Redis', () => {
  let redis: RedisClient
  let running: RunningApp
  const client = new Browser()

  const post = (path: string, body: unknown): Promise<BrowserResponse> =>
    client.postJSON(`${running.origin}${path}`, body)

  const signIn = async (identifier = 'alice', password = 'wonderland'): Promise<Pair> =>
    (await post('/token', { identifier, password })).json<Pair>()

  const refresh = (refreshToken: string) => post('/token/refresh', { refreshToken })

  const whoami = (accessToken: string) =>
    client.xhr(`${running.origin}/account`, { headers: { authorization: `Bearer ${accessToken}` } })

  beforeAll(async () => {
    users.set('alice', {
      id: 'alice',
      passwordHash: await hasher.hash('wonderland'),
      claims: [new Claim('roles', 'admin', '')],
    })

    redis = await connectRedis()

    const container = new CaffeineIoC()
    container.bind(Users, t => t.toSelf().extends())
    container.bind(PasswordHasher, t => t.toValue(hasher))
    container.bind(RefreshTokenStore, t =>
      t.toValue(new RedisRefreshTokenStore(redis, `caffeine:auth:e2e:${randomUUID()}`)),
    )

    running = await startApp(
      app =>
        app
          .authentication(auth =>
            auth
              .addJWTBearer(localJWT)
              .addCredentials()
              .addRefreshTokens(r => r.resolve(principalOf).accessTTL('5m').refreshTTL('1h')),
          )
          .mount(routes()),
      { container },
    )
  })

  afterAll(async () => {
    await running.close()
    await redis.close()
  })

  it('signs in for an access token that works and a refresh token that renews it', async () => {
    const first = await signIn()

    const account = await whoami(first.accessToken)
    expect(account.status).toBe(200)
    expect(account.json()).toEqual({ sub: 'alice', roles: 'admin' })

    const renewed = await refresh(first.refreshToken)
    expect(renewed.status).toBe(200)

    const second = renewed.json<Pair>()
    expect(second.refreshToken).not.toBe(first.refreshToken)
    expect((await whoami(second.accessToken)).status).toBe(200)
  })

  it('refuses a wrong password, and a refresh token it never issued', async () => {
    expect((await post('/token', { identifier: 'alice', password: 'nope' })).status).toBe(401)
    expect((await refresh('not-a-refresh-token')).status).toBe(401)
    expect((await refresh(`${randomUUID()}:${randomUUID()}`)).status).toBe(401)
  })

  // A refresh token is good once. Presented again, by a thief or by the client it was stolen from, it takes the
  // whole family with it — the pair handed out in between included — so both have to sign in again.
  it('revokes the family when a spent refresh token is presented again', async () => {
    const first = await signIn()
    const second = (await refresh(first.refreshToken)).json<Pair>()

    expect((await refresh(first.refreshToken)).status).toBe(401)
    expect((await refresh(second.refreshToken)).status).toBe(401)
  })

  // RFC 9700 §4.14.2. Reading the token and then writing the new one let every one of these through.
  it('lets exactly one of twenty simultaneous presentations of a refresh token through', async () => {
    for (let round = 0; round < 5; round++) {
      const { refreshToken } = await signIn()

      const responses = await Promise.all(Array.from({ length: 20 }, () => refresh(refreshToken)))
      const statuses = responses.map(response => response.status)

      expect(statuses.filter(status => status === 200)).toHaveLength(1)
      expect(statuses.filter(status => status === 401)).toHaveLength(19)

      // Presented twenty times is what a stolen copy looks like, so the one new pair is dead too.
      const winner = responses.find(response => response.status === 200)!.json<Pair>()
      expect((await refresh(winner.refreshToken)).status).toBe(401)
    }
  })

  it('ends one device’s sign-in on revoke, and every device’s on "sign out everywhere"', async () => {
    const laptop = await signIn()
    const phone = await signIn()
    const tablet = await signIn()

    expect((await post('/token/revoke', { refreshToken: laptop.refreshToken })).status).toBe(200)
    expect((await refresh(laptop.refreshToken)).status).toBe(401)

    const everywhere = await client.xhr(`${running.origin}/account/sign-out-everywhere`, {
      method: 'POST',
      headers: { authorization: `Bearer ${phone.accessToken}` },
    })
    expect(everywhere.status).toBe(200)

    expect((await refresh(phone.refreshToken)).status).toBe(401)
    expect((await refresh(tablet.refreshToken)).status).toBe(401)
  })

  it('stops renewing for a user the application no longer knows', async () => {
    users.set('carol', { id: 'carol', passwordHash: await hasher.hash('looking-glass') })
    const pair = await signIn('carol', 'looking-glass')

    users.delete('carol')

    expect((await refresh(pair.refreshToken)).status).toBe(401)
  })

  it('never stores the refresh token itself', async () => {
    const { refreshToken } = await signIn()
    const secret = refreshToken.split(':')[1]

    const values: string[] = []
    for await (const batch of redis.scanIterator({ MATCH: 'caffeine:auth:e2e:*:refresh:series:*' })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) {
        values.push(...Object.values(await redis.hGetAll(key)))
      }
    }

    expect(values.length).toBeGreaterThan(0)
    expect(values.some(value => value.includes(secret))).toBe(false)
  })
})
