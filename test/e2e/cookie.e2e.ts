import { CaffeineIoC } from '@caffeinejs/di'
import {
  AuthenticationService,
  AuthenticationTicket,
  Claim,
  type CredentialUser,
  CredentialsService,
  PasswordHasher,
  ScryptPasswordHasher,
  UserProvider,
  newRouter,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser } from './internal/browser/index.js'

/**
 * The cookie session scheme behind a credentials login, driven by a browser. No external system: the users and
 * the session are the application's own, so this spec never skips.
 */

const SCHEME = 'Cookie'
const SESSION_COOKIE = 'caf.session'
const SESSION_SECRET = 'cookie-e2e-session-secret-of-32-chars!'
const THIRTY_DAYS = 30 * 24 * 60 * 60

// Cheap on purpose: the cost parameter is the hasher's own concern and not what this spec is about.
const hasher = new ScryptPasswordHasher({ N: 1024 })

const users = new Map<string, CredentialUser>()

/** Subjects the application no longer accepts, which `validatePrincipal` consults on every request. */
const revoked = new Set<string>()

/** Set while the application cannot tell whether a session still stands, as when its user store is down. */
let outage = false

class Users extends UserProvider {
  findByIdentifier(identifier: string): CredentialUser | null {
    return users.get(identifier) ?? null
  }
}

interface LoginBody {
  identifier: string
  password: string
  rememberMe?: boolean
}

function routes() {
  const session = newRouter()
    .inject({ auth: AuthenticationService, credentials: CredentialsService })
    .get('/login', ctx => ({ page: 'login', returnUrl: ctx.req.query('returnUrl') ?? null }))
    .get('/denied', () => ({ page: 'denied' }))
    .post('/auth/login', async (ctx, { auth, credentials }) => {
      const body = ctx.req.body() as LoginBody
      const principal = await credentials.attempt(body.identifier, body.password)

      if (principal === null) {
        ctx.status(401)
        return { ok: false }
      }

      await auth.persist(ctx, SCHEME, new AuthenticationTicket(principal, SCHEME, { isPersistent: body.rememberMe }))
      return { ok: true }
    })
    .post('/auth/logout', async (ctx, { auth }) => {
      await auth.revoke(ctx, SCHEME)
      return { ok: true }
    })
    // A link into the login page that names where to come back to.
    .get('/go', async (ctx, { auth }) => {
      await auth.challenge(ctx, SCHEME, { redirectURI: ctx.req.query('to') })
    })

  return newRouter().mount(
    session,
    newRouter('/private')
      .authorize({})
      .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value })),
    newRouter('/admin')
      .authorize({ roles: ['admin'] })
      .get('/', () => ({ ok: true })),
  )
}

describe('cookie session behind a credentials login', () => {
  let running: RunningApp
  let origin: string

  const login = (browser: Browser, identifier: string, password: string, rememberMe = false) =>
    browser.postJSON(`${origin}/auth/login`, { identifier, password, rememberMe })

  beforeAll(async () => {
    users.set('alice', {
      id: 'alice',
      passwordHash: await hasher.hash('wonderland'),
      claims: [new Claim('roles', 'admin', ''), new Claim('email', 'alice@example.com', '')],
    })
    users.set('bob', {
      id: 'bob',
      passwordHash: await hasher.hash('builder'),
      claims: [new Claim('roles', 'user', '')],
    })

    const container = new CaffeineIoC()
    container.bind(Users, t => t.toSelf().extends())
    container.bind(PasswordHasher, t => t.toValue(hasher))

    running = await startApp(
      app =>
        app
          .authentication(auth =>
            auth
              .addCookie(c =>
                c
                  .sessionSecret(SESSION_SECRET)
                  // Plain http on localhost; a Secure cookie would never be sent back.
                  .secure(false)
                  .loginPath('/login')
                  .accessDeniedPath('/denied')
                  .validatePrincipal((_ctx, principal) => {
                    if (outage) {
                      throw new Error('the user store is unreachable')
                    }

                    return revoked.has(String(principal.findFirst('sub')?.value)) ? null : principal
                  }),
              )
              .addCredentials(),
          )
          .mount(routes()),
      { container },
    )
    origin = running.origin
  })

  afterAll(() => running.close())

  it('signs in with a password and carries the session on a cookie scripts cannot read', async () => {
    const browser = new Browser()

    expect((await login(browser, 'alice', 'wonderland')).status).toBe(200)

    const cookie = await browser.cookie(origin, SESSION_COOKIE)
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', hostOnly: true })
    // No lifetime of its own: it goes when the browser does.
    expect(cookie!.maxAge).toBeNull()
    expect(cookie!.expires).toBe('Infinity')

    const page = await browser.navigate(`${origin}/private`)
    expect(page.status).toBe(200)
    expect(page.json()).toEqual({ sub: 'alice' })
  })

  it('encrypts the session, so the claims are not readable in the cookie', async () => {
    const browser = new Browser()
    await login(browser, 'alice', 'wonderland')

    const { value } = (await browser.cookie(origin, SESSION_COOKIE))!
    const segments = value.split('.')

    // A compact JWE, not a signed-only token whose payload is base64 of the claims.
    expect(segments).toHaveLength(5)
    for (const segment of segments) {
      const text = Buffer.from(segment, 'base64url').toString('latin1')
      expect(text).not.toContain('alice')
      expect(text).not.toContain('admin')
    }
  })

  it.each([
    ['a wrong password', 'alice', 'not-the-password'],
    ['an unknown user', 'mallory', 'wonderland'],
  ])('refuses %s and sets no cookie', async (_label, identifier, password) => {
    const browser = new Browser()

    expect((await login(browser, identifier, password)).status).toBe(401)
    expect(await browser.cookie(origin, SESSION_COOKIE)).toBeUndefined()
  })

  it('sends a navigation to the login page with the way back, and answers a script 401', async () => {
    const browser = new Browser()

    const page = await browser.navigate(`${origin}/private?tab=1`)

    expect(page.hops[0]).toMatchObject({
      status: 302,
      location: `/login?returnUrl=${encodeURIComponent('/private?tab=1')}`,
    })
    expect(page.status).toBe(200)
    expect(page.json()).toEqual({ page: 'login', returnUrl: '/private?tab=1' })

    const script = await browser.xhr(`${origin}/private?tab=1`)

    expect(script.status).toBe(401)
    expect(script.json()).toEqual({
      error: 'authentication_required',
      loginURL: `/login?returnUrl=${encodeURIComponent('/private?tab=1')}`,
    })
  })

  it.each([
    ['an absolute URL on another origin', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a backslash the browser reads as a slash', '/\\evil.example/steal'],
  ])('drops the way back when it is %s', async (_label, to) => {
    const page = await new Browser().navigate(`${origin}/go?to=${encodeURIComponent(to)}`)

    expect(page.hops[0]).toMatchObject({ status: 302, location: '/login' })
  })

  it('keeps a way back that stays on this origin', async () => {
    const page = await new Browser().navigate(`${origin}/go?to=${encodeURIComponent('/private?tab=2')}`)

    expect(page.hops[0].location).toBe(`/login?returnUrl=${encodeURIComponent('/private?tab=2')}`)
  })

  it('signs out by clearing the cookie', async () => {
    const browser = new Browser()
    await login(browser, 'alice', 'wonderland')

    expect((await browser.postJSON(`${origin}/auth/logout`, {})).status).toBe(200)

    expect(await browser.cookie(origin, SESSION_COOKIE)).toBeUndefined()
    expect((await browser.xhr(`${origin}/private`)).status).toBe(401)
  })

  it('drops a session the application no longer accepts, and clears its cookie', async () => {
    const browser = new Browser()
    await login(browser, 'bob', 'builder')
    expect((await browser.xhr(`${origin}/private`)).status).toBe(200)

    revoked.add('bob')
    try {
      expect((await browser.xhr(`${origin}/private`)).status).toBe(401)
      expect(await browser.cookie(origin, SESSION_COOKIE)).toBeUndefined()
    } finally {
      revoked.delete('bob')
    }
  })

  // Not being able to tell is not the same as the answer being no. It used to be taken for a forged cookie, so an
  // outage signed everybody out without a word.
  it('answers with a server error while it cannot tell whether a session stands, and keeps the session', async () => {
    const browser = new Browser()
    await login(browser, 'alice', 'wonderland')

    outage = true
    try {
      expect((await browser.xhr(`${origin}/private`)).status).toBe(500)
      expect(await browser.cookie(origin, SESSION_COOKIE)).toBeDefined()
    } finally {
      outage = false
    }

    expect((await browser.xhr(`${origin}/private`)).status).toBe(200)
  })

  it('tells every cache to keep its hands off a response that sets, clears or asks for a session', async () => {
    const browser = new Browser()

    expect((await browser.navigate(`${origin}/private`)).hops[0].headers['cache-control']).toBe('no-store')
    expect((await browser.xhr(`${origin}/private`)).headers['cache-control']).toBe('no-store')
    expect((await login(browser, 'alice', 'wonderland')).headers['cache-control']).toBe('no-store')
    expect((await browser.postJSON(`${origin}/auth/logout`, {})).headers['cache-control']).toBe('no-store')
  })

  it('treats a tampered cookie as no session at all, never as a server error', async () => {
    const browser = new Browser()
    await login(browser, 'alice', 'wonderland')

    await browser.tamperCookie(origin, SESSION_COOKIE, value => `${value.slice(0, -4)}AAAA`)

    expect((await browser.xhr(`${origin}/private`)).status).toBe(401)
  })

  it('keeps the session across browser restarts when the user asked to be remembered', async () => {
    const browser = new Browser()
    await login(browser, 'alice', 'wonderland', true)

    expect((await browser.cookie(origin, SESSION_COOKIE))!.maxAge).toBe(THIRTY_DAYS)
  })

  it('sends a signed-in user who lacks the role to the access-denied page, not back to the login page', async () => {
    const browser = new Browser()
    await login(browser, 'bob', 'builder')

    const page = await browser.navigate(`${origin}/admin`)

    expect(page.hops[0]).toMatchObject({ status: 302, location: '/denied' })
    expect(page.json()).toEqual({ page: 'denied' })
  })

  it('lets the role through', async () => {
    const browser = new Browser()
    await login(browser, 'alice', 'wonderland')

    expect((await browser.navigate(`${origin}/admin`)).status).toBe(200)
  })
})

// A browser refuses a `__Host-` cookie that arrives without `Secure`, and that goes for the one that clears it.
// Cleared with `Path` alone, it stayed where it was, and signing out did nothing.
describe('a session cookie with the __Host- prefix', () => {
  const NAME = '__Host-session'

  it('is cleared at sign-out with the attributes it was set with, so the browser lets it go', async () => {
    const container = new CaffeineIoC()
    container.bind(Users, t => t.toSelf().extends())
    container.bind(PasswordHasher, t => t.toValue(hasher))
    users.set('alice', { id: 'alice', passwordHash: await hasher.hash('wonderland') })

    const running = await startApp(
      app =>
        app
          .authentication(auth =>
            auth.addCookie(c => c.sessionSecret(SESSION_SECRET).cookieName(NAME)).addCredentials(),
          )
          .mount(routes()),
      { container },
    )

    try {
      const client = new Browser()
      const signedIn = await client.postJSON(`${running.origin}/auth/login`, {
        identifier: 'alice',
        password: 'wonderland',
      })
      const set = signedIn.headersDistinct['set-cookie']!.find(line => line.startsWith(`${NAME}=`))!

      const signedOut = await client.xhr(`${running.origin}/auth/logout`, {
        method: 'POST',
        headers: { cookie: set.split(';', 1)[0], 'content-type': 'application/json' },
        body: '{}',
      })
      const cleared = signedOut.headersDistinct['set-cookie']!.find(line => line.startsWith(`${NAME}=`))!

      expect(cleared).toMatch(/;\s*Secure/i)
      expect(cleared).toMatch(/;\s*Path=\//i)

      // The browser's own verdict. The specs talk plain http, where such a cookie cannot exist, so the two lines
      // are replayed to a jar as the https origin a real deployment would be.
      const https = 'https://localhost/'
      const jar = new Browser()
      await jar.setCookieLine(https, set)
      expect(await jar.cookie(https, NAME)).toBeDefined()

      await jar.setCookieLine(https, cleared)
      expect(await jar.cookie(https, NAME)).toBeUndefined()
    } finally {
      await running.close()
    }
  })
})
