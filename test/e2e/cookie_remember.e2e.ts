import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { CaffeineIoC } from '@caffeinejs/di'
import {
  AuthenticationService,
  AuthenticationTicket,
  type CredentialUser,
  CredentialsService,
  PasswordHasher,
  REMEMBERED_CLAIM,
  RememberMeTokenStore,
  ScryptPasswordHasher,
  UserProvider,
  newRouter,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser } from './internal/browser/index.js'
import { reachable } from './internal/redis/index.js'
import { REDIS_URL, RedisRememberMeTokenStore, connectRedis, type RedisClient } from './internal/redis/stores.js'
import { required } from './internal/strict.js'

/**
 * Durable remember-me with the credentials held in Redis: a rotating token that outlives the session cookie, can
 * be revoked server-side, and is good once.
 */

const SCHEME = 'Cookie'
const SESSION = 'caf.session'
const REMEMBER = 'caf.remember'
const SECRET = 'remember-e2e-session-secret-of-32-chars'

// Short on purpose: long enough for a page's parallel requests, short enough for a spec to wait it out.
const GRACE_SECONDS = 2

const hasher = new ScryptPasswordHasher({ N: 1024 })
const users = new Map<string, CredentialUser>()

class Users extends UserProvider {
  findByIdentifier(identifier: string): CredentialUser | null {
    return users.get(identifier) ?? null
  }

  override findById(id: string): CredentialUser | null {
    return users.get(id) ?? null
  }
}

function routes() {
  return newRouter().mount(
    newRouter('/auth')
      .inject({ auth: AuthenticationService, credentials: CredentialsService })
      .post('/login', async (ctx, { auth, credentials }) => {
        const body = ctx.req.body() as { identifier: string; password: string }
        const principal = await credentials.attempt(body.identifier, body.password)

        if (principal === null) {
          ctx.status(401)
          return { ok: false }
        }

        await auth.persist(ctx, SCHEME, new AuthenticationTicket(principal, SCHEME, { isPersistent: true }))
        return { ok: true }
      })
      .post('/logout', async (ctx, { auth }) => {
        await auth.revoke(ctx, SCHEME)
        return { ok: true }
      }),
    newRouter('/private')
      .authorize({})
      .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value, remembered: ctx.user.hasClaim(REMEMBERED_CLAIM) })),
  )
}

const up = required('redis', await reachable(REDIS_URL))

describe.skipIf(!up)('durable remember-me held in Redis', () => {
  let redis: RedisClient
  let running: RunningApp
  let capped: RunningApp
  let origin: string

  async function start(configure: (seconds: { absolute?: number }) => { absolute?: number }): Promise<RunningApp> {
    const { absolute } = configure({})
    const container = new CaffeineIoC()
    container.bind(Users, t => t.toSelf().extends())
    container.bind(PasswordHasher, t => t.toValue(hasher))
    container.bind(RememberMeTokenStore, t =>
      t.toValue(new RedisRememberMeTokenStore(redis, `caffeine:auth:e2e:${randomUUID()}`)),
    )

    return startApp(
      app =>
        app
          .authentication(auth =>
            auth
              .addCookie(c => {
                c.sessionSecret(SECRET).secure(false).rememberMe().rememberMeRotationGraceSeconds(GRACE_SECONDS)

                if (absolute !== undefined) {
                  c.rememberMeMaxAge(3600).rememberMeAbsoluteMaxAge(absolute)
                }
              })
              .addCredentials(),
          )
          .mount(routes()),
      { container },
    )
  }

  /** A browser that signed in with "remember me" and whose session cookie has since gone, as it does overnight. */
  async function returning(app: RunningApp): Promise<Browser> {
    const browser = new Browser()
    expect(
      (await browser.postJSON(`${app.origin}/auth/login`, { identifier: 'alice', password: 'wonderland' })).status,
    ).toBe(200)
    await browser.dropCookie(app.origin, SESSION)

    return browser
  }

  beforeAll(async () => {
    users.set('alice', { id: 'alice', passwordHash: await hasher.hash('wonderland') })

    redis = await connectRedis()
    running = await start(() => ({}))
    capped = await start(() => ({ absolute: 2 }))
    origin = running.origin
  })

  afterAll(async () => {
    await running.close()
    await capped.close()
    await redis.close()
  })

  it('signs the user back in from the remember cookie, with a new token and a session marked as remembered', async () => {
    const browser = await returning(running)
    const before = (await browser.cookie(origin, REMEMBER))!.value

    const page = await browser.xhr(`${origin}/private`)

    expect(page.status).toBe(200)
    expect(page.json()).toEqual({ sub: 'alice', remembered: true })
    expect((await browser.cookie(origin, REMEMBER))!.value).not.toBe(before)
    expect(await browser.cookie(origin, SESSION)).toBeDefined()
  })

  it('does not mark a session that came from a sign-in', async () => {
    const browser = new Browser()
    await browser.postJSON(`${origin}/auth/login`, { identifier: 'alice', password: 'wonderland' })

    expect((await browser.xhr(`${origin}/private`)).json()).toEqual({ sub: 'alice', remembered: false })
  })

  // A page's requests go out together, each with the cookie as it stood when the batch began. The first to rotate
  // used to turn its siblings into apparent thefts, and the user was signed out by their own browser.
  it('lets a burst of parallel requests through on one token, and keeps the user signed in afterwards', async () => {
    for (let round = 0; round < 5; round++) {
      const browser = await returning(running)

      const statuses = (await Promise.all(Array.from({ length: 20 }, () => browser.xhr(`${origin}/private`)))).map(
        response => response.status,
      )
      expect(statuses).toEqual(Array.from({ length: 20 }, () => 200))

      // The next day: the session cookie is gone again, and the token the jar ended up with still works.
      await browser.dropCookie(origin, SESSION)
      expect((await browser.xhr(`${origin}/private`)).status).toBe(200)
    }
  })

  // A token that was already spent, presented once its grace has passed, means someone holds a copy of it. The
  // series goes, and with it the legitimate holder's token: that is the point of detecting it.
  it('revokes the series when a spent token comes back after the grace window', async () => {
    const browser = await returning(running)
    const stolen = (await browser.cookie(origin, REMEMBER))!

    expect((await browser.xhr(`${origin}/private`)).status).toBe(200)
    await sleep((GRACE_SECONDS + 1) * 1000)

    const thief = new Browser()
    await thief.adoptCookie(origin, stolen)
    expect((await thief.xhr(`${origin}/private`)).status).toBe(401)

    await browser.dropCookie(origin, SESSION)
    expect((await browser.xhr(`${origin}/private`)).status).toBe(401)
  })

  it('forgets the browser at sign-out, server-side: a copy of the remember cookie is dead too', async () => {
    const browser = await returning(running)
    const copy = new Browser()
    await copy.adoptCookie(origin, (await browser.cookie(origin, REMEMBER))!)

    expect((await browser.postJSON(`${origin}/auth/logout`, {})).status).toBe(200)

    expect(await browser.cookie(origin, REMEMBER)).toBeUndefined()
    expect((await copy.xhr(`${origin}/private`)).status).toBe(401)
  })

  // Every use pushes the idle lifetime back, so by itself it lets a browser that keeps coming back stay
  // remembered for good.
  it('stops remembering once the absolute lifetime is reached, however recently the browser came back', async () => {
    const browser = await returning(capped)
    expect((await browser.xhr(`${capped.origin}/private`)).status).toBe(200)

    await sleep(2500)
    await browser.dropCookie(capped.origin, SESSION)

    expect((await browser.xhr(`${capped.origin}/private`)).status).toBe(401)
  })
})
