import { describe, it, expect, beforeAll } from 'vitest'
import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import FastifyCookie from '@fastify/cookie'
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
  Params,
  type RememberMeRecord,
  RememberMeTokenStore,
  ScryptPasswordHasher,
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

class TestUserProvider extends UserProvider {
  findByIdentifier(identifier: string): CredentialUser | null {
    return identifier === 'alice' ? alice() : null
  }

  override findById(id: string): CredentialUser | null {
    return id === 'alice' ? alice() : null
  }
}

class InMemoryRememberStore extends RememberMeTokenStore {
  readonly records = new Map<string, RememberMeRecord>()
  create(record: RememberMeRecord): void { this.records.set(record.series, { ...record }) }
  findBySeries(series: string): RememberMeRecord | null { return this.records.get(series) ?? null }
  updateToken(series: string, tokenHash: string, expiresAt: number): void {
    const r = this.records.get(series)
    if (r) {
      r.tokenHash = tokenHash
      r.expiresAt = expiresAt
    }
  }

  remove(series: string): void { this.records.delete(series) }
  removeBySubject(subject: string): void {
    for (const [k, v] of this.records) {
      if (v.subject === subject) {
        this.records.delete(k)
      }
    }
  }
}

interface LoginDto { email: string, password: string, rememberMe?: boolean }

@Controller('/auth', [CredentialsService, AuthenticationService])
class SessionController {
  constructor(private readonly creds: CredentialsService, private readonly auth: AuthenticationService) {}

  @Params([$p.body(), $p.context()])
  @Post('/login')
  async login(dto: LoginDto, ctx: Context) {
    const user = await this.creds.attempt(dto.email, dto.password)
    if (!user) {
      ctx.status(401)
      return { ok: false }
    }
    await this.auth.persist(ctx, 'Cookie', new AuthenticationTicket(user, 'Cookie', { rememberMe: dto.rememberMe }))
    return { ok: true }
  }

  @Params([$p.context()])
  @Post('/logout')
  async logout(ctx: Context) {
    await this.auth.revoke(ctx, 'Cookie')
    return { ok: true }
  }
}

@Authorize()
@Controller('/me')
class MeController {
  @Params([$p.context()])
  @Get('/')
  me(ctx: Context) {
    return { sub: ctx.user.findFirst('sub')?.value, admin: ctx.user.isInRole('admin') }
  }
}
void [SessionController, MeController]

async function buildApp() {
  const f = fastify()
  f.register(FastifyCookie)
  const container = new CaffeineIoC()
  container.bind(TestUserProvider).toSelf().extends()
  // Fast hasher keeps the test snappy; overrides the fallback ScryptPasswordHasher from addCredentials.
  container.bind(PasswordHasher).toValue(new ScryptPasswordHasher({ N: 1024 }))
  const builder = createWebApplication(fastifyAdapterFactory(f), { container })
  builder.authentication(auth => auth
    .addCookie(o => o.sessionSecret(SECRET).secure(false))
    .addCredentials())
  const app = builder.build()
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
    const body = await me.json() as Record<string, unknown>
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

async function buildDurableApp() {
  const f = fastify()
  f.register(FastifyCookie)
  const container = new CaffeineIoC()
  container.bind(TestUserProvider).toSelf().extends()
  const store = new InMemoryRememberStore()
  container.bind(RememberMeTokenStore).toValue(store)
  container.bind(PasswordHasher).toValue(new ScryptPasswordHasher({ N: 1024 }))
  const builder = createWebApplication(fastifyAdapterFactory(f), { container })
  builder.authentication(auth => auth
    .addCookie(o => o.sessionSecret(SECRET).secure(false).rememberMe())
    .addCredentials())
  const app = builder.build()
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
    expect((await me.json() as Record<string, unknown>).admin).toBe(true)

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
    const { app } = await buildDurableApp()
    const original = cookiesFrom(await login(app, { email: 'alice', password: 's3cret', rememberMe: true }))['caf.remember']

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
})
