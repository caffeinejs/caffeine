import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  AuthorizationBuilder,
  AuthzRequirementHandler,
  BaseAuthenticationHandler,
  ErrAuthzPolicyEmpty,
  createWebApplication,
  fastifyAdapterFactory,
  newRouter,
  type AuthzRequirement,
} from '../../index.js'

/**
 * What the authorization builder refuses. No controller is declared here, routers only: a controller registers
 * into a process-global registry, and these applications are built to fail.
 */

describe('AuthorizationBuilder — a policy with no requirement', () => {
  // Satisfied by every caller, the anonymous one included: it reads as a rule and enforces nothing.
  it('refuses one registered by name, with a builder that added nothing', () => {
    expect(() => new AuthorizationBuilder().addPolicy('nothing', () => undefined)).toThrow(ErrAuthzPolicyEmpty)
    expect(() => new AuthorizationBuilder().addPolicy('nothing', () => undefined)).toThrow(/"nothing"/)
  })

  it('refuses one handed over already built', () => {
    expect(() => new AuthorizationBuilder().addPolicy({ name: 'nothing', requirements: [] })).toThrow(
      ErrAuthzPolicyEmpty,
    )
  })

  it('refuses one as the policy a bare @Authorize stands for', () => {
    const builder = new AuthorizationBuilder()

    expect(() => builder.authorizeDecoratorDefaultPolicy(() => undefined)).toThrow(ErrAuthzPolicyEmpty)
    expect(() => builder.authorizeDecoratorDefaultPolicy({ name: '', requirements: [] })).toThrow(ErrAuthzPolicyEmpty)
  })

  it('refuses one as the fallback policy', () => {
    const builder = new AuthorizationBuilder()

    expect(() => builder.fallbackPolicy(() => undefined)).toThrow(ErrAuthzPolicyEmpty)
    expect(() => builder.fallbackPolicy({ name: '', requirements: [] })).toThrow(ErrAuthzPolicyEmpty)
  })

  it('accepts a policy with a single requirement', () => {
    const builder = new AuthorizationBuilder()

    expect(() => builder.addPolicy('signed-in', p => p.requireAuthenticated())).not.toThrow()
    expect(() => builder.fallbackPolicy(p => p.requireAuthenticated())).not.toThrow()
  })
})

describe('AuthorizationBuilder — two handlers for one requirement kind', () => {
  class NeverAuthenticates extends BaseAuthenticationHandler<object> {
    constructor() {
      super({})
    }

    authenticate(): Promise<AuthenticateResult> {
      return Promise.resolve(AuthenticateResult.none())
    }
  }

  // Claims the kind the built-in role handler owns. Which of the two would evaluate `@Roles` was decided by
  // the order the container listed them in.
  class AdmitsEveryRole extends AuthzRequirementHandler<AuthzRequirement> {
    get kind(): string {
      return 'role'
    }

    handle() {
      return { ok: true }
    }
  }

  it('refuses to start rather than let binding order pick one', async () => {
    const container = new CaffeineIoC()
    container.bind(AdmitsEveryRole, t => t.toSelf().lifetime(Scopes.SINGLETON).extends(AuthzRequirementHandler))

    const app = createWebApplication(fastifyAdapterFactory(fastify()), { container })
      .authentication(auth => auth.addStrategy('Never', new NeverAuthenticates()))
      .mount(
        newRouter('/admin')
          .authorize({ roles: ['admin'] })
          .get('/', () => ({ ok: true })),
      )

    await expect(app.ready()).rejects.toMatchObject({ code: 'ERR_AUTHZ_REQUIREMENT_HANDLER_DUPLICATE' })
  })
})
