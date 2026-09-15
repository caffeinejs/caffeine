import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Authorize,
  Claim,
  type Context,
  Controller,
  Get,
  Identity,
  JWTService,
  Args,
  Post,
  Principal,
  type RefreshTokenRecord,
  RefreshTokenService,
  RefreshTokenStore,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../../../index.js'

const SECRET = 'a-very-long-test-secret-key-32-bytes!'
const ISSUER = 'https://test.example.com'

function alicePrincipal(): Principal {
  return new Principal(
    true,
    new Identity('Bearer', true, [new Claim('sub', 'alice', ''), new Claim('roles', ['admin'], '')]),
  )
}

class InMemoryRefreshStore extends RefreshTokenStore {
  readonly records = new Map<string, RefreshTokenRecord>()
  create(record: RefreshTokenRecord): void {
    this.records.set(record.series, { ...record })
  }
  findBySeries(series: string): RefreshTokenRecord | null {
    return this.records.get(series) ?? null
  }
  updateToken(series: string, tokenHash: string, expiresAt: number): void {
    const r = this.records.get(series)
    if (r) {
      r.tokenHash = tokenHash
      r.expiresAt = expiresAt
    }
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

interface RefreshDto {
  refreshToken: string
}

// Injects the refresh grant AND the shared JWTService directly (proves G1: same signer as the scheme).
@Controller('/auth', [RefreshTokenService, JWTService])
class AuthController {
  constructor(
    private readonly refresh: RefreshTokenService,
    private readonly jwt: JWTService,
  ) {}

  @Post('/login')
  async login() {
    return this.refresh.issue(alicePrincipal())
  }

  @Args([$p.body()])
  @Post('/refresh')
  async doRefresh(dto: RefreshDto) {
    return this.refresh.refresh(dto.refreshToken)
  }

  @Args([$p.body()])
  @Post('/logout-all')
  async logoutAll(dto: RefreshDto) {
    await this.refresh.revokeAllForSubject('alice')
    void dto
    return { ok: true }
  }

  @Post('/guest')
  async guest() {
    return { token: await this.jwt.sign({ scope: ['guest'] }) }
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
void [AuthController, MeController]

async function buildApp() {
  const container = new CaffeineIoC()
  const store = new InMemoryRefreshStore()
  container.bind(RefreshTokenStore, t => t.toValue(store))
  const builder = createWebApplication(fastifyAdapterFactory(fastify()), { container })
  builder.authentication(a =>
    a
      .addJWTBearer(o => o.secret(SECRET).issuer(ISSUER).expiresIn('15m').allowAnyAudience())
      .addRefreshTokens(o => o.refreshTTL('30d').resolve(sub => (sub === 'alice' ? alicePrincipal() : null))),
  )
  const app = builder
  await app.ready()
  return { app, store }
}

async function postJSON(app: Awaited<ReturnType<typeof buildApp>>['app'], path: string, body?: unknown) {
  return body != null
    ? app.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    : app.fetch(path, { method: 'POST' })
}

describe('bearer refresh-token grant (application)', () => {
  it('login issues a pair; the access token authenticates a protected route', async () => {
    const { app } = await buildApp()

    const res = await postJSON(app, '/auth/login')
    expect(res.status).toBe(200)
    const { accessToken, refreshToken } = (await res.json()) as Record<string, string>
    expect(accessToken).toBeTruthy()
    expect(refreshToken).toContain(':')

    const me = await app.fetch('/me', { headers: { authorization: `Bearer ${accessToken}` } })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ sub: 'alice', admin: true })
  })

  it('refresh rotates the refresh token and returns a working access token', async () => {
    const { app } = await buildApp()
    const first = (await (await postJSON(app, '/auth/login')).json()) as Record<string, string>

    const res = await postJSON(app, '/auth/refresh', { refreshToken: first.refreshToken })
    expect(res.status).toBe(200)
    const next = (await res.json()) as Record<string, string>
    expect(next.refreshToken).not.toBe(first.refreshToken)

    const me = await app.fetch('/me', { headers: { authorization: `Bearer ${next.accessToken}` } })
    expect(me.status).toBe(200)
  })

  it('replaying a pre-rotation refresh token is rejected (401) as theft', async () => {
    const { app } = await buildApp()
    const first = (await (await postJSON(app, '/auth/login')).json()) as Record<string, string>
    await postJSON(app, '/auth/refresh', { refreshToken: first.refreshToken }) // rotate

    const replay = await postJSON(app, '/auth/refresh', { refreshToken: first.refreshToken })
    expect(replay.status).toBe(401)
  })

  it('server-side revoke (revokeAllForSubject) kills the refresh credential', async () => {
    const { app } = await buildApp()
    const first = (await (await postJSON(app, '/auth/login')).json()) as Record<string, string>

    await postJSON(app, '/auth/logout-all', { refreshToken: first.refreshToken })

    const res = await postJSON(app, '/auth/refresh', { refreshToken: first.refreshToken })
    expect(res.status).toBe(401)
  })

  it('the shared JWTService is injectable and issues tokens the scheme verifies (G1)', async () => {
    const { app } = await buildApp()

    const { token } = (await (await postJSON(app, '/auth/guest')).json()) as Record<string, string>
    expect(token).toBeTruthy()

    // A self-issued guest token authenticates (valid JWT) but is not an admin.
    const me = await app.fetch('/me', { headers: { authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ sub: undefined, admin: false })
  })
})
