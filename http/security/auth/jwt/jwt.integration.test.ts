import { describe, it, expect, vi } from 'vitest'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import {
  AllowAnonymous,
  Authorize,
  type Context,
  Controller,
  Get,
  Params,
  Post,
  Status,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../../../index.js'

const TEST_SECRET = 'test-secret-key-must-be-at-least-32-chars!!'
const secretBytes = new TextEncoder().encode(TEST_SECRET)

async function signToken(
  payload: Record<string, unknown>,
  opts: { issuer?: string, audience?: string } = {},
): Promise<string> {
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')

  if (opts.issuer) {
    builder = builder.setIssuer(opts.issuer)
  }
  if (opts.audience) {
    builder = builder.setAudience(opts.audience)
  }

  return builder.sign(secretBytes)
}

async function signExpiredToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() - 1000))
    .sign(secretBytes)
}

describe('JWTBearerHandler', () => {
  it('accepts a valid HS256 token on a protected route', async () => {
    @Authorize()
    @Controller('/jwt-valid')
    class JWTValidController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTValidController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-1' })
    const res = await app.fetch('/jwt-valid', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('returns 401 with WWW-Authenticate: Bearer when no Authorization header', async () => {
    @Authorize()
    @Controller('/jwt-no-header')
    class JWTNoHeaderController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTNoHeaderController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/jwt-no-header')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('returns 401 for a malformed token', async () => {
    @Authorize()
    @Controller('/jwt-bad-token')
    class JWTBadTokenController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTBadTokenController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/jwt-bad-token', {
      headers: { authorization: 'Bearer not.a.valid.jwt' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 for an expired token', async () => {
    @Authorize()
    @Controller('/jwt-expired')
    class JWTExpiredController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTExpiredController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const token = await signExpiredToken({ sub: 'user-expired' })
    const res = await app.fetch('/jwt-expired', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when issuer does not match', async () => {
    @Authorize()
    @Controller('/jwt-wrong-iss')
    class JWTWrongIssController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTWrongIssController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b =>
      b.secret(TEST_SECRET).jwtOptions({ issuer: 'https://expected.example.com', algorithms: ['HS256'] }),
    )
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-1' }, { issuer: 'https://other.example.com' })
    const res = await app.fetch('/jwt-wrong-iss', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when audience does not match', async () => {
    @Authorize()
    @Controller('/jwt-wrong-aud')
    class JWTWrongAudController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTWrongAudController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b =>
      b.secret(TEST_SECRET).jwtOptions({ audience: 'my-api', algorithms: ['HS256'] }),
    )
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-1' }, { audience: 'other-api' })
    const res = await app.fetch('/jwt-wrong-aud', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('exposes sub claim via ctx.user.findFirst', async () => {
    @Authorize()
    @Controller('/jwt-sub-claim')
    class JWTSubClaimController {
      @Params([$p.context()])
      @Get('/')
      list(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [JWTSubClaimController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'alice-123' })
    const res = await app.fetch('/jwt-sub-claim', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.sub).toBe('alice-123')
  })

  it('maps a roles claim so isInRole works', async () => {
    @Authorize({ roles: ['admin'] })
    @Controller('/jwt-role')
    class JWTRoleController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTRoleController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-1', roles: 'admin' })
    const res = await app.fetch('/jwt-role', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('expands an array roles claim so each value becomes a separate Claim', async () => {
    @Authorize({ roles: ['editor'] })
    @Controller('/jwt-array-roles')
    class JWTArrayRolesController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTArrayRolesController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-1', roles: ['admin', 'editor'] })
    const res = await app.fetch('/jwt-array-roles', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it('fires onTokenValidated hook after successful verification', async () => {
    const onTokenValidated = vi.fn()

    @Authorize()
    @Controller('/jwt-on-validated')
    class JWTOnValidatedController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTOnValidatedController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b =>
      b.secret(TEST_SECRET).onTokenValidated((_ctx, payload) => { onTokenValidated(payload) }),
    )
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-hook' })
    await app.fetch('/jwt-on-validated', {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(onTokenValidated).toHaveBeenCalledOnce()
    const [payload] = onTokenValidated.mock.calls[0] as [Record<string, unknown>]
    expect(payload.sub).toBe('user-hook')
  })

  it('fires onFail hook on bad token', async () => {
    const onFail = vi.fn()

    @Authorize()
    @Controller('/jwt-on-fail')
    class JWTOnFailController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTOnFailController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b =>
      b.secret(TEST_SECRET).onFail((_ctx, err) => { onFail(err) }),
    )
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/jwt-on-fail', {
      headers: { authorization: 'Bearer not.a.jwt' },
    })

    expect(res.status).toBe(401)
    expect(onFail).toHaveBeenCalledOnce()
    const [err] = onFail.mock.calls[0] as [Error]
    expect(err).toBeInstanceOf(Error)
  })

  it('returns 403 when roles do not match even with valid JWT', async () => {
    @Authorize({ roles: ['admin'] })
    @Controller('/jwt-role-403')
    class JWTRole403Controller {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JWTRole403Controller]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const token = await signToken({ sub: 'user-1', roles: 'viewer' })
    const res = await app.fetch('/jwt-role-403', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
  })

  it('a failed challenge halts before the handler even when @Status is set', async () => {
    // Regression: challenge()/forbid() only set the status on the reply; the authz onRequest hook
    // must finalize the response so the route handler never runs. Otherwise the handler executes
    // (side effects and all) and an explicit @Status would overwrite the 401 with the success code.
    let handlerRan = false

    @Controller('/jwt-status-guard')
    class JWTStatusGuardController {
      @Post('/')
      @Status(201)
      @Authorize({ roles: ['admin'] })
      create() {
        handlerRan = true
        return { ok: true }
      }
    }
    void [JWTStatusGuardController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/jwt-status-guard', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(handlerRan).toBe(false)
  })

  it('@AllowAnonymous on a method of a JWT-protected class skips verification', async () => {
    @Authorize()
    @Controller('/jwt-allow-anon')
    class JWTAllowAnonController {
      @Get('/protected')
      protected() {
        return { ok: true }
      }

      @AllowAnonymous()
      @Get('/public')
      public() {
        return { ok: true }
      }
    }
    void [JWTAllowAnonController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addJWTBearer(b => b.secret(TEST_SECRET))
    const app = builder.build()
    await app.ready()

    const [protectedRes, publicRes] = await Promise.all([
      app.fetch('/jwt-allow-anon/protected'),
      app.fetch('/jwt-allow-anon/public'),
    ])

    expect(protectedRes.status).toBe(401)
    expect(publicRes.status).toBe(200)
  })
})
