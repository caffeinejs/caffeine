import { $t } from '@caffeinejs/std'
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
  ErrAuthenticationRequired,
  Get,
  Identity,
  Post,
  Principal,
  Schema,
  createWebApplication,
} from '../index.js'

/**
 * The authentication extension — authentication and the authorization that is folded into it.
 *
 * The cases here are the ones it documents at length: the reset a route's own schemes perform, the per-scheme
 * challenge against the single forbid, and the start-up failure that keeps a misconfiguration from becoming a
 * silently unguarded route.
 */

/** Authenticates any request carrying `x-user`, and counts what the extension asked of it. */
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

describe('authentication extension — start-up', () => {
  it('refuses to start when a route is protected but authentication is not configured', async () => {
    @Authorize()
    @Controller('/ext-auth-missing')
    class MissingController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [MissingController]

    // No `.authentication(...)`: the extension is still registered unconditionally, and it is what refuses
    // the application rather than serve the guarded route to anonymous callers.
    const app = createWebApplication()

    await expect(app.ready()).rejects.toThrow(ErrAuthenticationRequired)
  })

  // The "route names a scheme nothing registered" case lives in
  // authentication_extension_unknown_scheme.test.ts:
  // `@Controller` registers globally and every container built afterwards snapshots that registry, so a
  // controller declared to fail start-up would fail every application built later in the same file.
})

describe('authentication extension — requests', () => {
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

  it('does not accept the default scheme on a route that names its own', async () => {
    @Authorize({ schemes: ['Second'] })
    @Controller('/mw-auth-reset')
    class ResetController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [ResetController]

    const { app } = newApp()
    await app.ready()

    // A valid default-scheme credential is not a credential for this route: naming a scheme narrows what
    // the route accepts, it never widens it.
    const withDefault = await app.fetch('/mw-auth-reset', { headers: { 'x-default': 'someone' } })
    expect(withDefault.status).toBe(401)

    const withNamed = await app.fetch('/mw-auth-reset', { headers: { 'x-second': 'someone' } })
    expect(withNamed.status).toBe(200)
    await app.close()
  })

  it('merges the identities of every named scheme the caller satisfied', async () => {
    let seen: Principal | undefined

    @Authorize({ schemes: ['First', 'Second'] })
    @Controller('/mw-auth-merge')
    class MergeController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [MergeController]

    const { app } = newApp()
    app.use((ctx, next) => {
      seen = ctx.user
      return next()
    })
    await app.ready()

    const res = await app.fetch('/mw-auth-merge', { headers: { 'x-first': 'a', 'x-second': 'b' } })

    expect(res.status).toBe(200)
    expect(seen!.identities).toHaveLength(2)
    expect(seen!.hasClaim('First', 'a')).toBe(true)
    expect(seen!.hasClaim('Second', 'b')).toBe(true)
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
