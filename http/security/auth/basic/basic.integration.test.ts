import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import {
  Authorize,
  Claim,
  type Context,
  Controller,
  Get,
  Identity,
  Args,
  Principal,
  createWebApplication,
  fastifyAdapterFactory,
  $p,
} from '../../../index.js'

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

describe('BasicAuthenticationHandler (application)', () => {
  it('accepts valid credentials on a protected route and exposes ctx.user', async () => {
    @Authorize()
    @Controller('/basic-ok')
    class BasicOkController {
      @Args([$p.context()])
      @Get('/')
      list(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [BasicOkController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth =>
      auth.addBasic(b =>
        b.validate((_ctx, user, pass) =>
          user === 'alice' && pass === 'secret'
            ? new Principal(true, new Identity('Basic', true, [new Claim('sub', user, '')]))
            : null,
        ),
      ),
    )
    const app = builder
    await app.ready()

    const res = await app.fetch('/basic-ok', { headers: { authorization: basicHeader('alice', 'secret') } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).sub).toBe('alice')
  })

  it('challenges with 401 and WWW-Authenticate: Basic when no credentials are sent', async () => {
    @Authorize()
    @Controller('/basic-challenge')
    class BasicChallengeController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [BasicChallengeController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addBasic(b => b.realm('My App').validate(() => null)))
    const app = builder
    await app.ready()

    const res = await app.fetch('/basic-challenge')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="My App"')
  })

  it('returns 401 when validate rejects the credentials', async () => {
    @Authorize()
    @Controller('/basic-bad')
    class BasicBadController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [BasicBadController]

    const builder = createWebApplication(fastifyAdapterFactory(fastify()))
    builder.authentication(auth => auth.addBasic(b => b.validate(() => null)))
    const app = builder
    await app.ready()

    const res = await app.fetch('/basic-bad', { headers: { authorization: basicHeader('alice', 'wrong') } })
    expect(res.status).toBe(401)
  })
})
