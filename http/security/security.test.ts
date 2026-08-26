import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
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
  Roles,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/auth-role-403')
    expect(res.status).toBe(403)
  })

  it('@Roles gates identically to @Authorize({ roles }) — 200 with the role', async () => {
    @Roles('admin')
    @Controller('/roles-ok')
    class RolesOkController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [RolesOkController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'admin' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/roles-ok')
    expect(res.status).toBe(200)
  })

  it('@Roles returns 403 when the user lacks the required role', async () => {
    @Roles('admin')
    @Controller('/roles-403')
    class Roles403Controller {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [Roles403Controller]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'viewer' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/roles-403')
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
    builder.authentication(auth => auth.addStrategy('default', new CustomChallengeHandler()).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', new CustomForbidHandler()).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/auth-custom-forbid')
    expect(res.status).toBe(403)
    expect(res.headers.get('x-forbidden-reason')).toBe('insufficient-role')
  })

  it('ctx.user is accessible inside the route handler after successful auth', async () => {
    @Authorize()
    @Controller('/auth-ctx-user')
    class CtxUserController {
      @Params([$p.context()])
      @Get('/')
      list(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [CtxUserController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'sub', value: 'alice' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/auth-ctx-user')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.sub).toBe('alice')
  })
})

// ---------------------------------------------------------------------------
// Section C — Authorization policies
// ---------------------------------------------------------------------------

describe('authorization policies', () => {
  // Regression: `schemes` used to count toward the "no requirements were declared" test, so naming one skipped
  // the default authenticated-user policy and compiled to an empty policy that admitted everyone. Adding a
  // scheme must never be the thing that removes the requirement to be authenticated.
  it('@Authorize({ schemes }) still requires an authenticated user', async () => {
    @Authorize({ schemes: ['default'] })
    @Controller('/authz-schemes-only')
    class SchemesOnlyController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [SchemesOnlyController]

    const handler = new FakeAuthHandler()
    handler.result = AuthenticateResult.none()

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/authz-schemes-only')
    expect(res.status).toBe(401)
  })

  it('@Authorize({ schemes }) admits an authenticated user', async () => {
    @Authorize({ schemes: ['default'] })
    @Controller('/authz-schemes-only-ok')
    class SchemesOnlyOKController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [SchemesOnlyOKController]

    const handler = new FakeAuthHandler()
    handler.result = successTicket([{ type: 'roles', value: 'viewer' }])

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/authz-schemes-only-ok')
    expect(res.status).toBe(200)
  })

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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    builder.authorization(authz => authz.addPolicy('AdminOnly', b => b.role('admin')))
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    builder.authorization(authz => {
      authz.addPolicy('AdminOnly', b => b.role('admin'))
      authz.addPolicy('AdminOnly2', b => b.role('admin'))
    })
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    builder.authorization(authz => {
      authz.addPolicy('AdminOnly', b => b.role('admin'))
      authz.addPolicy('AdminOnly2', b => b.role('admin'))
      authz.authorizeDecoratorDefaultPolicy(b => b.requireAuthenticated())
    })
    const app = builder.build().useAuthenticationAndAuthorization()
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
    builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
    builder.authorization(authz => {
      authz.addPolicy('AdminOnly', b => b.role('admin'))
      authz.addPolicy('AdminOnly2', b => b.role('admin'))
      authz.addPolicy('CanReadOrders', b => b.claim('permission', 'orders:read'))
    })
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/authz-claim-ok')
    expect(res.status).toBe(200)
  })
})
