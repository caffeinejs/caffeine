import { describe, it, expect, vi } from 'vitest'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import {
  AllowAnonymous,
  Authorize,
  AuthenticateResult,
  AuthenticationTicket,
  type Context,
  Controller,
  Get,
  BaseAuthenticationHandler,
  Claim,
  Identity,
  Params,
  Principal,
  createWebApplication,
  fastifyAdapterFactory,
  context,
} from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

class FakeAuthHandler extends BaseAuthenticationHandler<{}> {
  result: AuthenticateResult = AuthenticateResult.none()

  constructor() {
    super({})
  }

  async authenticate(_ctx: Context): Promise<AuthenticateResult> {
    return this.result
  }
}

function successTicket(claims: Array<{ type: string, value: string }> = [], scheme = 'default'): AuthenticateResult {
  const identity = new Identity(scheme, true, claims.map(c => new Claim(c.type, c.value, '')))
  const principal = new Principal(true, [identity])
  return AuthenticateResult.success(new AuthenticationTicket(principal, scheme))
}

// ---------------------------------------------------------------------------
// Section A — authentication + authorization with a fake handler
// ---------------------------------------------------------------------------

describe('auth configurer (fake handler)', () => {
  it('does not restrict routes with no @Authorize', async () => {
    @Controller('/auth-open')
    class OpenController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [OpenController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.fetch('/auth-open')
    expect(res.status).toBe(200)
  })

  it('returns 401 when @Authorize is on the class and handler returns none', async () => {
    @Authorize()
    @Controller('/auth-class-401')
    class ProtectedController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [ProtectedController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.none()

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-class-401')
    expect(res.status).toBe(401)
  })

  it('returns 200 when @Authorize on class and handler returns success', async () => {
    @Authorize()
    @Controller('/auth-class-200')
    class AuthClass200Controller {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [AuthClass200Controller]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'sub', value: 'u1' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-class-200')
    expect(res.status).toBe(200)
  })

  it('returns 401 when @Authorize on class and handler returns fail', async () => {
    @Authorize()
    @Controller('/auth-class-fail')
    class AuthClassFailController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [AuthClassFailController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.fail(new Error('bad token'))

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-class-fail')
    expect(res.status).toBe(401)
  })

  it('@AllowAnonymous on a method overrides class-level @Authorize', async () => {
    @Authorize()
    @Controller('/auth-anon-method')
    class AnonMethodController {
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
    void [AnonMethodController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.none()

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const [protectedRes, publicRes] = await Promise.all([
      app.fetch('/auth-anon-method/protected'),
      app.fetch('/auth-anon-method/public'),
    ])

    expect(protectedRes.status).toBe(401)
    expect(publicRes.status).toBe(200)
  })

  it('@AllowAnonymous on a class makes all routes anonymous', async () => {
    @AllowAnonymous()
    @Controller('/auth-anon-class')
    class AnonClassController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [AnonClassController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.none()

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-anon-class')
    expect(res.status).toBe(200)
  })

  it('@Authorize on a method only protects that method, not others on the class', async () => {
    @Controller('/auth-method-only')
    class MethodOnlyController {
      @Get('/open')
      open() {
        return { ok: true }
      }

      @Authorize()
      @Get('/secured')
      secured() {
        return { ok: true }
      }
    }
    void [MethodOnlyController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.none()

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const [openRes, securedRes] = await Promise.all([
      app.fetch('/auth-method-only/open'),
      app.fetch('/auth-method-only/secured'),
    ])

    expect(openRes.status).toBe(200)
    expect(securedRes.status).toBe(401)
  })

  it('@Authorize({ roles }) returns 200 when user has the required role', async () => {
    @Authorize({ roles: ['admin'] })
    @Controller('/auth-role-ok')
    class RoleOkController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [RoleOkController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'admin' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-role-ok')
    expect(res.status).toBe(200)
  })

  it('@Authorize({ roles }) returns 403 when user lacks the required role', async () => {
    @Authorize({ roles: ['admin'] })
    @Controller('/auth-role-403')
    class Role403Controller {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [Role403Controller]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'viewer' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-role-403')
    expect(res.status).toBe(403)
  })

  it('custom challenge() on handler is called and can set custom headers', async () => {
    class CustomChallengeHandler extends BaseAuthenticationHandler<{}> {
      constructor() { super({}) }

      async authenticate(_ctx: Context): Promise<AuthenticateResult> {
        return AuthenticateResult.none()
      }

      override async challenge(ctx: Context): Promise<void> {
        ctx.status(401).header('X-Auth-Realm', 'my-realm')
      }
    }

    @Authorize()
    @Controller('/auth-custom-challenge')
    class CustomChallengeController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [CustomChallengeController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', new CustomChallengeHandler()).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-custom-challenge')
    expect(res.status).toBe(401)
    expect(res.headers.get('x-auth-realm')).toBe('my-realm')
  })

  it('custom forbid() on handler is called and can set custom headers', async () => {
    class CustomForbidHandler extends BaseAuthenticationHandler<{}> {
      constructor() { super({}) }

      async authenticate(_ctx: Context): Promise<AuthenticateResult> {
        return successTicket([{ type: 'roles', value: 'viewer' }])
      }

      override async forbid(ctx: Context): Promise<void> {
        ctx.status(403).header('X-Forbidden-Reason', 'insufficient-role')
      }
    }

    @Authorize({ roles: ['admin'] })
    @Controller('/auth-custom-forbid')
    class CustomForbidController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [CustomForbidController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', new CustomForbidHandler()).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-custom-forbid')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-forbidden-reason')).toBe('insufficient-role')
  })

  it('ctx.user is accessible inside the route handler after successful auth', async () => {
    @Authorize()
    @Controller('/auth-ctx-user')
    class CtxUserController {
      @Params([context()])
      @Get('/')
      list(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [CtxUserController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'sub', value: 'alice' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/auth-ctx-user')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.sub).toBe('alice')
  })
})

// ---------------------------------------------------------------------------
// Section B — JwtBearerHandler integration (real tokens via SignJWT)
// ---------------------------------------------------------------------------

describe('JwtBearerHandler', () => {
  it('accepts a valid HS256 token on a protected route', async () => {
    @Authorize()
    @Controller('/jwt-valid')
    class JwtValidController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtValidController]

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
    class JwtNoHeaderController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtNoHeaderController]

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
    class JwtBadTokenController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtBadTokenController]

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
    class JwtExpiredController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtExpiredController]

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
    class JwtWrongIssController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtWrongIssController]

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
    class JwtWrongAudController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtWrongAudController]

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
    class JwtSubClaimController {
      @Params([context()])
      @Get('/')
      list(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [JwtSubClaimController]

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
    class JwtRoleController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtRoleController]

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
    class JwtArrayRolesController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtArrayRolesController]

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
    class JwtOnValidatedController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtOnValidatedController]

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
    class JwtOnFailController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtOnFailController]

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
    class JwtRole403Controller {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [JwtRole403Controller]

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

  it('@AllowAnonymous on a method of a JWT-protected class skips verification', async () => {
    @Authorize()
    @Controller('/jwt-allow-anon')
    class JwtAllowAnonController {
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
    void [JwtAllowAnonController]

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

// ---------------------------------------------------------------------------
// Section C — Authorization policies
// ---------------------------------------------------------------------------

describe('authorization policies', () => {
  it('named policy via @Authorize({ policy }) enforces requirements', async () => {
    @Authorize({ policy: 'AdminOnly' })
    @Controller('/authz-named-policy')
    class NamedPolicyController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [NamedPolicyController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'admin' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    builder.authorization.addPolicy('AdminOnly', b => b.requireRole('admin'))
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/authz-named-policy')
    expect(res.status).toBe(200)
  })

  it('named policy denies when requirement not met', async () => {
    @Authorize({ policy: 'AdminOnly2' })
    @Controller('/authz-named-policy-deny')
    class NamedPolicyDenyController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [NamedPolicyDenyController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'viewer' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    builder.authorization.addPolicy('AdminOnly2', b => b.requireRole('admin'))
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/authz-named-policy-deny')
    expect(res.status).toBe(403)
  })

  it('requireAuthenticatedUser fails for anonymous principal', async () => {
    @Authorize()
    @Controller('/authz-require-auth')
    class RequireAuthController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [RequireAuthController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.none()

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    builder.authorization.authorizeDecoratorDefaultPolicy(b => b.requireAuthenticated())
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/authz-require-auth')
    expect(res.status).toBe(401)
  })

  it('claims-based requirement: requireClaim allows matching user', async () => {
    @Authorize({ policy: 'CanReadOrders' })
    @Controller('/authz-claim-ok')
    class ClaimOkController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [ClaimOkController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'permission', value: 'orders:read' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication.addScheme('default', handler).default('default')
    builder.authorization.addPolicy('CanReadOrders', b => b.requireClaim('permission', 'orders:read'))
    const app = builder.build()
    await app.ready()

    const res = await app.fetch('/authz-claim-ok')
    expect(res.status).toBe(200)
  })
})
