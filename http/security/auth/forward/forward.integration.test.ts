import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { SignJWT } from 'jose'
import {
  Authorize,
  Claim,
  Controller,
  Get,
  Identity,
  Principal,
  createWebApplication,
  fastifyAdapterFactory,
} from '../../../index.js'

const TEST_SECRET = 'test-secret-key-must-be-at-least-32-chars!!'
const secretBytes = new TextEncoder().encode(TEST_SECRET)

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secretBytes)
}

describe('scheme negotiation (Forward, application)', () => {
  function forwardBuilder() {
    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth
      .addBasic('Basic', b => b.validate((_ctx, user, pass) =>
        user === 'alice' && pass === 'secret'
          ? new Principal(true, new Identity('Basic', true, [new Claim('sub', user, '')]))
          : null))
      .addJWTBearer('Bearer', b => b.secret(TEST_SECRET).allowAnyIssuer().allowAnyAudience())
      .forward('Forward', ctx =>
        ctx.req.header('authorization')?.startsWith('Basic ') ? 'Basic' : 'Bearer')
      .default('Forward'))
    return builder
  }

  it('routes Basic credentials to the Basic scheme', async () => {
    @Authorize()
    @Controller('/fwd-basic')
    class FwdBasicController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [FwdBasicController]

    const app = forwardBuilder().build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/fwd-basic', { headers: { authorization: basicHeader('alice', 'secret') } })
    expect(res.status).toBe(200)
  })

  it('routes a Bearer token to the JWT scheme', async () => {
    @Authorize()
    @Controller('/fwd-jwt')
    class FwdJwtController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [FwdJwtController]

    const app = forwardBuilder().build().useAuthenticationAndAuthorization()
    await app.ready()

    const token = await signToken({ sub: 'user-1' })
    const res = await app.fetch('/fwd-jwt', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })

  it('returns 401 when neither scheme can authenticate the request', async () => {
    @Authorize()
    @Controller('/fwd-none')
    class FwdNoneController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [FwdNoneController]

    const app = forwardBuilder().build().useAuthenticationAndAuthorization()
    await app.ready()

    const res = await app.fetch('/fwd-none', { headers: { authorization: 'Bearer not-a-jwt' } })
    expect(res.status).toBe(401)
  })
})
