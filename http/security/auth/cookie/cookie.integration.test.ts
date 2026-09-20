import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, it, expect, beforeAll, vi } from 'vitest'

import {
  Authorize,
  AuthenticationService,
  AuthenticationTicket,
  Claim,
  type Context,
  Controller,
  type CredentialUser,
  CredentialsService,
  Get,
  PasswordHasher,
  Post,
  Args,
  RememberMeTokenStore,
  ScryptPasswordHasher,
  type SeriesTokenRecord,
  type SeriesTokenRotation,
  UserProvider,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../../../index.js'

const SECRET = 'session-secret-that-is-at-least-32-bytes!'
let ALICE_HASH = ''

function alice(): CredentialUser {
  return { id: 'alice', passwordHash: ALICE_HASH, claims: [new Claim('roles', 'admin', '')] }
}

/** Whether the account still exists. A remember-me credential outlives its sign-in by weeks, and an account may not. */
let aliceDeleted = false

class TestUserProvider extends UserProvider {
  findByIdentifier(identifier: string): CredentialUser | null {
    return identifier === 'alice' && !aliceDeleted ? alice() : null
  }

  override findById(id: string): CredentialUser | null {
    return id === 'alice' && !aliceDeleted ? alice() : null
  }
}

class InMemoryRememberStore extends RememberMeTokenStore {
  readonly records = new Map<string, SeriesTokenRecord>()
  rotations = 0
  create(record: SeriesTokenRecord): void {
    this.records.set(record.series, { ...record })
  }
  findBySeries(series: string): SeriesTokenRecord | null {
    const r = this.records.get(series)
    return r === undefined ? null : { ...r }
  }
  rotate(series: string, expectedTokenHash: string, rotation: SeriesTokenRotation): boolean {
    const r = this.records.get(series)
    if (r === undefined || r.tokenHash !== expectedTokenHash) {
      return false
    }

    this.rotations++
    Object.assign(r, rotation)
    return true
  }

  remove(series: string): void {
    this.records.delete(series)
  }
  removeBySubject(subject: string): void {
    for (const [k, v] of this.records) {
      if (v.subject === subject) {
        this.records.delete(k)
      }
    }
  }
}

interface LoginDto {
  email: string
  password: string
  rememberMe?: boolean
}

@Controller('/auth', [CredentialsService, AuthenticationService])
class SessionController {
  constructor(
    private readonly creds: CredentialsService,
    private readonly auth: AuthenticationService,
  ) {}

  @Args([$p.body(), $p.context()])
  @Post('/login')
  async login(dto: LoginDto, ctx: Context) {
    const user = await this.creds.attempt(dto.email, dto.password)
    if (!user) {
      ctx.status(401)
      return { ok: false }
    }
    await this.auth.persist(ctx, 'Cookie', new AuthenticationTicket(user, 'Cookie', { isPersistent: dto.rememberMe }))
    return { ok: true }
  }

  @Args([$p.context()])
  @Post('/logout')
  async logout(ctx: Context) {
    await this.auth.revoke(ctx, 'Cookie')
    return { ok: true }
  }
}

@Authorize()
@Controller('/me')
class MeController {
  @Args([$p.context()])
  @Get('/')
  me(ctx: Context) {
    return { sub: ctx.user.findFirst('sub')?.value, admin: ctx.user.isInRole('admin') }
  }
}
/**
 * Names the scheme it is already protected by, which is what makes a request authenticate twice: the
 * controller-scope hook runs the default scheme, then the per-route hook runs the schemes named here.
 */
@Authorize({ schemes: ['Cookie'] })
@Controller('/scoped-me')
class SchemeScopedMeController {
  @Args([$p.context()])
  @Get('/')
  me(ctx: Context) {
    return { sub: ctx.user.findFirst('sub')?.value }
  }
}
void [SessionController, MeController, SchemeScopedMeController]

async function buildApp() {
  const f = fastify()
  const container = new CaffeineIoC()
  container.bind(TestUserProvider, t => t.toSelf().extends())
  // Fast hasher keeps the test snappy; overrides the fallback ScryptPasswordHasher from addCredentials.
  container.bind(PasswordHasher, t => t.toValue(new ScryptPasswordHasher({ N: 1024 })))
  const builder = createWebApplication(fastifyAdapterFactory(f), { container })
  builder.authentication(auth => auth.addCookie(o => o.sessionSecret(SECRET).secure(false)).addCredentials())
  const app = builder
  await app.ready()
  return app
}

function sessionCookie(setCookie: string | null): string {
  const m = /caf\.session=([^;]+)/.exec(setCookie ?? '')
  if (!m) {
    throw new Error(`no session cookie in Set-Cookie: ${setCookie}`)
  }
  return `caf.session=${m[1]}`
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, dto: LoginDto) {
  return app.fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dto),
  })
}

beforeAll(async () => {
  ALICE_HASH = await new ScryptPasswordHasher({ N: 1024 }).hash('s3cret')
})

describe('cookie session login (application)', () => {
  it('logs in, authenticates the follow-up request via the cookie, exposes ctx.user', async () => {
    const app = await buildApp()

    const res = await login(app, { email: 'alice', password: 's3cret' })
    expect(res.status).toBe(200)
    const cookie = sessionCookie(res.headers.get('set-cookie'))

    const me = await app.fetch('/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as Record<string, unknown>
    expect(body.sub).toBe('alice')
    expect(body.admin).toBe(true)
  })

  it('rejects the protected route without a session cookie', async () => {
    const app = await buildApp()
    const me = await app.fetch('/me')
    expect(me.status).toBe(401)
  })

  it('returns 401 for wrong credentials and sets no session cookie', async () => {
    const app = await buildApp()
    const res = await login(app, { email: 'alice', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('caf.session=')
  })

  it('logout clears the cookie so the protected route rejects again', async () => {
    const app = await buildApp()

    const res = await login(app, { email: 'alice', password: 's3cret' })
    const cookie = sessionCookie(res.headers.get('set-cookie'))

    const out = await app.fetch('/auth/logout', { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(200)
    // The cleared cookie has an empty/expired value; the protected route no longer authenticates.
    const cleared = out.headers.get('set-cookie') ?? ''
    expect(cleared).toContain('caf.session=')
    const me = await app.fetch('/me', { headers: { cookie: 'caf.session=' } })
    expect(me.status).toBe(401)
  })

  describe('remember-me', () => {
    it('issues a persistent cookie (Max-Age) when rememberMe is true', async () => {
      const app = await buildApp()
      const res = await login(app, { email: 'alice', password: 's3cret', rememberMe: true })
      expect(res.headers.get('set-cookie')).toContain('Max-Age=')
    })

    it('issues a session cookie (no Max-Age) when rememberMe is absent', async () => {
      const app = await buildApp()
      const res = await login(app, { email: 'alice', password: 's3cret' })
      expect(res.headers.get('set-cookie')).not.toContain('Max-Age=')
    })
  })
})

// ---------------------------------------------------------------------------
// Durable, server-side-revocable remember-me (series + token)
// ---------------------------------------------------------------------------

async function buildDurableApp(graceSeconds?: number) {
  const f = fastify()
  const container = new CaffeineIoC()
  container.bind(TestUserProvider, t => t.toSelf().extends())
  const store = new InMemoryRememberStore()
  container.bind(RememberMeTokenStore, t => t.toValue(store))
  container.bind(PasswordHasher, t => t.toValue(new ScryptPasswordHasher({ N: 1024 })))
  const builder = createWebApplication(fastifyAdapterFactory(f), { container })
  builder.authentication(auth =>
    auth
      .addCookie(o => {
        o.sessionSecret(SECRET).secure(false).rememberMe()
        if (graceSeconds !== undefined) {
          o.rememberMeRotationGraceSeconds(graceSeconds)
        }
      })
      .addCredentials(),
  )
  const app = builder
  await app.ready()
  return { app, store }
}

function cookiesFrom(res: Awaited<ReturnType<typeof login>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of res.headers.getSetCookie()) {
    const m = /^([^=]+)=([^;]+)/.exec(c)
    if (m) {
      out[m[1]] = m[2]
    }
  }
  return out
}

describe('durable remember-me (server-side revocable)', () => {
  it('refreshes a session from the remember cookie after the session cookie is gone', async () => {
    const { app, store } = await buildDurableApp()

    const c = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))
    expect(c['caf.remember']).toBeDefined()
    expect(store.records.size).toBe(1)

    // Only the remember cookie — the session cookie is "expired"/absent.
    const me = await app.fetch('/me', { headers: { cookie: `caf.remember=${c['caf.remember']}` } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as Record<string, unknown>).admin).toBe(true)

    // The token was rotated: a fresh remember cookie, different value.
    const rotated = cookiesFrom(me)['caf.remember']
    expect(rotated).toBeDefined()
    expect(rotated).not.toBe(c['caf.remember'])
  })

  it('server-side revoke (removeBySubject) kills the remember credential', async () => {
    const { app, store } = await buildDurableApp()
    const c = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))

    store.removeBySubject('alice')

    const me = await app.fetch('/me', { headers: { cookie: `caf.remember=${c['caf.remember']}` } })
    expect(me.status).toBe(401)
  })

  it('detects theft: replaying a pre-rotation token invalidates the series', async () => {
    // Grace disabled — strict single-use, which is what a deployment that would rather sign a user out
    // than tolerate any replay window configures.
    const { app } = await buildDurableApp(0)
    const original = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))[
      'caf.remember'
    ]

    // First use rotates the token.
    const first = await app.fetch('/me', { headers: { cookie: `caf.remember=${original}` } })
    expect(first.status).toBe(200)
    const rotated = cookiesFrom(first)['caf.remember']

    // Replaying the original (now stale) token is a theft signal → 401 and the series is nuked.
    const replay = await app.fetch('/me', { headers: { cookie: `caf.remember=${original}` } })
    expect(replay.status).toBe(401)

    // Even the rotated token no longer works once the series is invalidated.
    const after = await app.fetch('/me', { headers: { cookie: `caf.remember=${rotated}` } })
    expect(after.status).toBe(401)
  })

  it('survives a route that authenticates twice in one request', async () => {
    // `/scoped-me` names the scheme it is already protected by, so the request authenticates twice: once
    // at the controller scope for the default scheme, once more at the route for the named one. Each
    // authenticate rotates the remember token, and cookie reads come from the *request*, so the second
    // call used to replay the token the first had just spent — self-inflicted theft detection that signed
    // the user out. The per-request memo in AuthenticationService is what collapses this to one call.
    const { app, store } = await buildDurableApp(0)
    const remember = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))[
      'caf.remember'
    ]

    const res = await app.fetch('/scoped-me', { headers: { cookie: `caf.remember=${remember}` } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).sub).toBe('alice')

    // One rotation, not two — and the series is still alive.
    expect(store.rotations).toBe(1)
    expect(store.records.size).toBe(1)

    const rotated = cookiesFrom(res)['caf.remember']
    expect(rotated).toBeDefined()
    const after = await app.fetch('/scoped-me', { headers: { cookie: `caf.remember=${rotated}` } })
    expect(after.status).toBe(200)
  })

  it('tolerates a just-rotated token inside the grace window without rotating again', async () => {
    // The parallel-request case: a browser fires several requests carrying the same remember cookie, one
    // of them rotates, and the rest arrive holding a token that is already superseded. Treating those as
    // theft would sign the user out every time a session expired mid-page-load.
    const { app, store } = await buildDurableApp()
    const original = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))[
      'caf.remember'
    ]

    const first = await app.fetch('/me', { headers: { cookie: `caf.remember=${original}` } })
    expect(first.status).toBe(200)
    const rotated = cookiesFrom(first)['caf.remember']

    const raced = await app.fetch('/me', { headers: { cookie: `caf.remember=${original}` } })
    expect(raced.status).toBe(200)

    // The racer must not spend a second token on the winner's behalf: no new remember cookie, and the
    // record still holds exactly what the winner rotated to.
    expect(cookiesFrom(raced)['caf.remember']).toBeUndefined()
    expect(store.records.size).toBe(1)

    // The winner's token is still the live one.
    const after = await app.fetch('/me', { headers: { cookie: `caf.remember=${rotated}` } })
    expect(after.status).toBe(200)
  })

  it('treats a superseded token as theft once the grace window has passed', async () => {
    const { app } = await buildDurableApp()
    const original = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))[
      'caf.remember'
    ]

    const first = await app.fetch('/me', { headers: { cookie: `caf.remember=${original}` } })
    expect(first.status).toBe(200)
    const rotated = cookiesFrom(first)['caf.remember']

    // Only Date is faked: timers stay real so the server's own async work is unaffected.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 61_000)

      const replay = await app.fetch('/me', { headers: { cookie: `caf.remember=${original}` } })
      expect(replay.status).toBe(401)

      const after = await app.fetch('/me', { headers: { cookie: `caf.remember=${rotated}` } })
      expect(after.status).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  /** The `Set-Cookie` line that clears `name`, if the response carries one. */
  function cleared(res: Response, name: string): string | undefined {
    return res.headers.getSetCookie().find(line => line.startsWith(`${name}=;`))
  }

  // The credential is good for thirty days and says nothing about the account, which is looked up again each
  // time. An account deleted in between is not signed back in by a cookie issued while it existed.
  it('does not remember back in a user who no longer exists, and revokes the credential', async () => {
    const { app, store } = await buildDurableApp()
    const c = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))

    aliceDeleted = true
    try {
      const me = await app.fetch('/me', { headers: { cookie: `caf.remember=${c['caf.remember']}` } })

      expect(me.status).toBe(401)
      expect(store.records.size).toBe(0)
      expect(cleared(me, 'caf.remember')).toBeDefined()
      expect(cookiesFrom(me)['caf.session']).toBeUndefined()
    } finally {
      aliceDeleted = false
    }
  })

  // Two requests present the same token and the store lets one of them rotate. With no grace window the other
  // has spent a token that was already spent, which is what a stolen copy looks like: nobody keeps the series.
  it('takes a rotation lost to another request, outside any grace, for a replay', async () => {
    const { app, store } = await buildDurableApp(0)
    const c = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))

    // The other request wins between this one's read and its swap.
    store.rotate = (series: string) => {
      Object.assign(store.records.get(series)!, { tokenHash: 'rotated-by-the-other-request' })
      return false
    }

    const me = await app.fetch('/me', { headers: { cookie: `caf.remember=${c['caf.remember']}` } })

    expect(me.status).toBe(401)
    expect(store.records.size).toBe(0)
    expect(cleared(me, 'caf.remember')).toBeDefined()
    expect(cookiesFrom(me)['caf.session']).toBeUndefined()
  })

  // Signing out is about the browser that asked. One that holds no remember-me cookie has no series to revoke,
  // and the credential another browser of the same user holds is not its to take away.
  it('signs out a browser that holds no remember-me cookie without touching the series of another', async () => {
    const { app, store } = await buildDurableApp()
    await login(app, { email: 'alice', password: 's3cret', rememberMe: true })
    const here = cookiesFrom(await login(app, { email: 'alice', password: 's3cret' }))

    const out = await app.fetch('/auth/logout', {
      method: 'POST',
      headers: { cookie: `caf.session=${here['caf.session']}` },
    })

    expect(out.status).toBe(200)
    expect(cleared(out, 'caf.session')).toBeDefined()
    expect(store.records.size).toBe(1)
  })
})
