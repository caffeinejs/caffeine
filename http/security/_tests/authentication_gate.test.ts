import { $t } from '@caffeinejs/std/schema'
import { describe, it, expect } from 'vitest'

import {
  AllowAnonymous,
  AuthenticateResult,
  AuthenticationTicket,
  Authorize,
  BaseAuthenticationHandler,
  Claim,
  type Context,
  Controller,
  Get,
  Identity,
  Post,
  Principal,
  Schema,
  createWebApplication,
} from '../../index.js'

/**
 * The authentication gate — authentication and the authorization that is folded into it.
 *
 * The cases here are the ones it documents at length: the order against body validation, the per-scheme
 * challenge against the single forbid, and the principal a route that is not gated still sees.
 */

/** Authenticates any request carrying `x-user`, and counts what the gate asked of it. */
class HeaderSchemeHandler extends BaseAuthenticationHandler<object> {
  challenges = 0
  forbids = 0

  constructor(
    private readonly scheme: string,
    private readonly header: string,
  ) {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const user = ctx.req.header(this.header)
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const principal = new Principal(true, [
      new Identity(this.scheme, true, [new Claim('sub', user, ''), new Claim(this.scheme, user, '')]),
    ])

    return AuthenticateResult.success(new AuthenticationTicket(principal, this.scheme))
  }

  override async challenge(ctx: Context): Promise<void> {
    this.challenges++
    ctx.status(401).header('x-challenged-by', this.scheme)
  }

  override async forbid(ctx: Context): Promise<void> {
    this.forbids++
    ctx.status(403).header('x-forbidden-by', this.scheme)
  }
}

/**
 * Every application in this file registers the same three schemes.
 *
 * Not a convenience: `@Controller` registers into a global registry and each container snapshots it, so a
 * controller declared in one test is present in every application built afterwards — including the ones that
 * name `First`/`Second`. The extension reads every route at start-up, so every application has to know every
 * scheme some route names.
 */
function newApp() {
  const byDefault = new HeaderSchemeHandler('Default', 'x-default')
  const first = new HeaderSchemeHandler('First', 'x-first')
  const second = new HeaderSchemeHandler('Second', 'x-second')

  const builder = createWebApplication()
  builder.authentication(auth =>
    auth.addStrategy('Default', byDefault).addStrategy('First', first).addStrategy('Second', second).default('Default'),
  )

  return { app: builder, byDefault, first, second }
}

describe('authentication gate — requests', () => {
  it('answers 401 before validating the body, so the schema is not described to an anonymous caller', async () => {
    let handlerRan = false

    @Authorize()
    @Controller('/mw-auth-body')
    class BodyController {
      @Post('/')
      @Schema({ body: $t.Object({ name: $t.String() }) })
      create() {
        handlerRan = true
        return { ok: true }
      }
    }
    void [BodyController]

    const { app } = newApp()
    await app.ready()

    // The body is invalid against the schema, so a validation-first pipeline would answer 400 here.
    const res = await app.fetch('/mw-auth-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 }),
    })

    expect(res.status).toBe(401)
    expect(handlerRan).toBe(false)
    await app.close()
  })

  it('challenges every scheme a route names, and forbids only once', async () => {
    @Authorize({ schemes: ['First', 'Second'], roles: ['admin'] })
    @Controller('/mw-auth-multi')
    class MultiController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [MultiController]

    const { app, first, second } = newApp()
    await app.ready()

    // Anonymous: both named schemes advertise how to authenticate.
    expect((await app.fetch('/mw-auth-multi')).status).toBe(401)
    expect(first.challenges).toBe(1)
    expect(second.challenges).toBe(1)

    // Authenticated but lacking the role: one decision, taken once.
    const denied = await app.fetch('/mw-auth-multi', { headers: { 'x-first': 'someone' } })
    expect(denied.status).toBe(403)
    expect(first.forbids).toBe(1)
    expect(second.forbids).toBe(0)
    await app.close()
  })

  it('keeps the default-scheme principal on an @AllowAnonymous route', async () => {
    let seen: Principal | undefined

    @Authorize()
    @Controller('/mw-auth-anon')
    class AnonController {
      @AllowAnonymous()
      @Get('/open')
      open() {
        return { ok: true }
      }
    }
    void [AnonController]

    const { app } = newApp()
    app.use((ctx, next) => {
      seen = ctx.user
      return next()
    })
    await app.ready()

    const res = await app.fetch('/mw-auth-anon/open', { headers: { 'x-default': 'someone' } })

    expect(res.status).toBe(200)
    expect(seen!.authenticated).toBe(true)
    expect(seen!.hasClaim('sub', 'someone')).toBe(true)
    await app.close()
  })

  it('leaves an unprotected route reachable, with an anonymous principal', async () => {
    let seen: Principal | undefined

    @Controller('/mw-auth-open')
    class OpenController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [OpenController]

    const { app } = newApp()
    app.use((ctx, next) => {
      seen = ctx.user
      return next()
    })
    await app.ready()

    const res = await app.fetch('/mw-auth-open')

    expect(res.status).toBe(200)
    expect(seen!.authenticated).toBe(false)
    await app.close()
  })
})
