import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '@caffeinejs/di'
import fastify from 'fastify'
import {
  Authorize,
  Claim,
  type Context,
  Controller,
  Get,
  Identity,
  OpaqueTokenStore,
  Args,
  Principal,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../../../index.js'

class FakeOpaqueStore extends OpaqueTokenStore {
  validate(token: string): Principal | null {
    if (token === 'good-token') {
      return new Principal(true, new Identity('OpaqueToken', true, [
        new Claim('sub', 'user-1', ''),
        new Claim('scope', 'orders:write', ''),
      ]))
    }
    if (token === 'reader-token') {
      return new Principal(true, new Identity('OpaqueToken', true, [
        new Claim('sub', 'user-2', ''),
        new Claim('scope', 'orders:read', ''),
      ]))
    }
    return null
  }
}

function opaqueBuilder() {
  const container = new CaffeineIoC()
  container.bind(OpaqueTokenStore).toClass(FakeOpaqueStore)
  const builder = createWebApplication(fastifyAdapterFactory(fastify()), { container })
  // Only the policy this file's own controller references — no cross-section superset needed, since
  // each test file has an isolated decorator registrar.
  builder.authorization(authz => authz.addPolicy('WriteOrders', b => b.requireAuthenticated().claim('scope', 'orders:write')))
  return builder
}

describe('OpaqueTokenAuthenticationHandler (application, DI-bound store)', () => {
  it('authenticates a known token via the container-resolved store and exposes ctx.user', async () => {
    @Authorize()
    @Controller('/opaque-ok')
    class OpaqueOkController {
      @Args([$p.context()])
      @Get('/')
      list(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value, scope: ctx.user.findFirst('scope')?.value }
      }
    }
    void [OpaqueOkController]

    const builder = opaqueBuilder()
    builder.authentication(auth => auth.addOpaqueToken())
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/opaque-ok', { headers: { authorization: 'Bearer good-token' } })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.sub).toBe('user-1')
    expect(body.scope).toBe('orders:write')
  })

  it('returns 401 when no token is sent', async () => {
    @Authorize()
    @Controller('/opaque-none')
    class OpaqueNoneController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [OpaqueNoneController]

    const builder = opaqueBuilder()
    builder.authentication(auth => auth.addOpaqueToken())
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/opaque-none')
    expect(res.status).toBe(401)
  })

  it('returns 401 when the store rejects the token (unknown/revoked/expired)', async () => {
    @Authorize()
    @Controller('/opaque-bad')
    class OpaqueBadController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [OpaqueBadController]

    const builder = opaqueBuilder()
    builder.authentication(auth => auth.addOpaqueToken())
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/opaque-bad', { headers: { authorization: 'Bearer bad-token' } })
    expect(res.status).toBe(401)
  })

  it('gates a route by a scope claim through the real policy pipeline', async () => {
    @Authorize({ policy: 'WriteOrders' })
    @Controller('/opaque-scope')
    class OpaqueScopeController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [OpaqueScopeController]

    const builder = opaqueBuilder()
    builder.authentication(auth => auth.addOpaqueToken())
    const app = builder.build().useAuthenticationAndAuthorization()
    await app.ready()

    const granted = await app.fetch('/opaque-scope', { headers: { authorization: 'Bearer good-token' } })
    expect(granted.status).toBe(200)

    const denied = await app.fetch('/opaque-scope', { headers: { authorization: 'Bearer reader-token' } })
    expect(denied.status).toBe(403)
  })
})
