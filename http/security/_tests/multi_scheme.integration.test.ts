import { afterEach, describe, expect, it } from 'vitest'

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
  Args,
  Principal,
  WebApplication,
  createWebApplication,
  $p,
} from '../../index.js'

/**
 * Per-route authentication scheme selection.
 *
 * Every application here registers two schemes: a `Default` one that is the application default, and a
 * `Basic` one that only a route naming it may use. The pairing is the point — it is what makes "the caller
 * authenticated, but not the way this route demands" an expressible state.
 */

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/**
 * The application default scheme: any request carrying `x-default-user` is authenticated.
 *
 * A handler of its own rather than a Basic scheme with a custom `validate`, because Basic returns `none()`
 * before `validate` ever runs unless an `Authorization: Basic` header is present — so a header-driven
 * credential could never satisfy it. Reading a different header is what makes "authenticated, but not the way
 * this route demands" reachable.
 */
class DefaultSchemeHandler extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const user = ctx.req.header('x-default-user')
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const principal = new Principal(true, [new Identity('Default', true, [new Claim('sub', user, '')])])

    return AuthenticateResult.success(new AuthenticationTicket(principal, 'Default'))
  }
}

function buildApp(): WebApplication {
  const builder = createWebApplication()

  builder.authentication(auth =>
    auth
      .addStrategy('Default', new DefaultSchemeHandler())
      .addBasic('Basic', b =>
        b
          .realm('Docs')
          .validate((_ctx, user, pass) =>
            user === 'admin' && pass === 'admin123'
              ? new Principal(true, [new Identity('Basic', true, [new Claim('sub', 'admin', '')])])
              : null,
          ),
      )
      .default('Default'),
  )

  return builder as WebApplication
}

describe('per-route authentication schemes', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('authenticates with the named scheme rather than the default', async () => {
    @Controller('/docs-scheme')
    class DocsSchemeController {
      @Get('/')
      @Authorize({ schemes: ['Basic'] })
      @Args([$p.context()])
      read(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [DocsSchemeController]

    app = buildApp()
    await app.ready()

    const res = await app.fetch('/docs-scheme', { headers: { authorization: basicHeader('admin', 'admin123') } })

    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).sub).toBe('admin')
  })

  it('challenges with the named scheme, not the application default', async () => {
    @Controller('/docs-challenge')
    class DocsChallengeController {
      @Get('/')
      @Authorize({ schemes: ['Basic'] })
      read() {
        return { ok: true }
      }
    }
    void [DocsChallengeController]

    app = buildApp()
    await app.ready()

    const res = await app.fetch('/docs-challenge')

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Docs')
  })

  // The reason the per-route hook resets `req.user`. The scope-level hook authenticates the default scheme
  // for every route, so without the reset this caller arrives already authenticated, the Basic attempt fails
  // silently, and authorization lets them through — naming a scheme would widen access instead of narrowing
  // it. A 200 here means the reset is gone.
  it('rejects a caller authenticated by the DEFAULT scheme on a route that names another', async () => {
    @Controller('/docs-downgrade')
    class DocsDowngradeController {
      @Get('/')
      @Authorize({ schemes: ['Basic'] })
      read() {
        return { ok: true }
      }
    }
    void [DocsDowngradeController]

    app = buildApp()
    await app.ready()

    const res = await app.fetch('/docs-downgrade', { headers: { 'x-default-user': 'mallory' } })

    expect(res.status).toBe(401)
  })

  it('tries named schemes in order and takes the first that succeeds', async () => {
    @Controller('/multi')
    class MultiController {
      @Get('/')
      @Authorize({ schemes: ['Basic', 'Default'] })
      @Args([$p.context()])
      read(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [MultiController]

    app = buildApp()
    await app.ready()

    const viaBasic = await app.fetch('/multi', { headers: { authorization: basicHeader('admin', 'admin123') } })
    expect(viaBasic.status).toBe(200)
    expect(((await viaBasic.json()) as Record<string, unknown>).sub).toBe('admin')

    // The second scheme still authenticates when the first cannot.
    const viaDefault = await app.fetch('/multi', { headers: { 'x-default-user': 'dana' } })
    expect(viaDefault.status).toBe(200)
    expect(((await viaDefault.json()) as Record<string, unknown>).sub).toBe('dana')
  })

  it('leaves a route naming no scheme on the application default', async () => {
    @Controller('/plain')
    class PlainController {
      @Get('/')
      @Authorize()
      @Args([$p.context()])
      read(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [PlainController]

    app = buildApp()
    await app.ready()

    const authenticated = await app.fetch('/plain', { headers: { 'x-default-user': 'dana' } })
    expect(authenticated.status).toBe(200)
    expect(((await authenticated.json()) as Record<string, unknown>).sub).toBe('dana')

    expect((await app.fetch('/plain')).status).toBe(401)
  })

  it('does not clobber the principal on an allowAnonymous route that names schemes', async () => {
    @Controller('/anon')
    class AnonController {
      @Get('/')
      @AllowAnonymous()
      @Authorize({ schemes: ['Basic'] })
      @Args([$p.context()])
      read(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value ?? null }
      }
    }
    void [AnonController]

    app = buildApp()
    await app.ready()

    // The handler still sees whoever the default scheme authenticated, because the route is not gated and
    // taking that away would break an optional-identity handler.
    const res = await app.fetch('/anon', { headers: { 'x-default-user': 'dana' } })

    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).sub).toBe('dana')
  })

  // Guards the effective-authz merge in buildRouting: only the route's own options used to be surfaced, so a
  // controller-level scheme reached compileRoutePolicy but was invisible to everything reading
  // Route.authorization.options — this hook among them.
  it('honours schemes declared on the controller', async () => {
    @Authorize({ schemes: ['Basic'] })
    @Controller('/class-scheme')
    class ClassSchemeController {
      @Get('/')
      @Args([$p.context()])
      read(ctx: Context) {
        return { sub: ctx.user.findFirst('sub')?.value }
      }
    }
    void [ClassSchemeController]

    app = buildApp()
    await app.ready()

    const viaBasic = await app.fetch('/class-scheme', { headers: { authorization: basicHeader('admin', 'admin123') } })
    expect(viaBasic.status).toBe(200)

    const viaDefault = await app.fetch('/class-scheme', { headers: { 'x-default-user': 'mallory' } })
    expect(viaDefault.status).toBe(401)
  })

  it('merges the identities of every scheme the caller satisfied', async () => {
    // First-wins made this unreachable: whichever scheme the decorator listed first won and the other
    // identity was discarded, so a policy could never see claims asserted by both.
    @Authorize({ schemes: ['Default', 'Basic'] })
    @Controller('/both-schemes')
    class BothSchemesController {
      @Get('/')
      @Args([$p.context()])
      read(ctx: Context) {
        return { types: ctx.user.identities.map(i => i.authenticationType) }
      }
    }
    void [BothSchemesController]

    app = buildApp()
    await app.ready()

    const res = await app.fetch('/both-schemes', {
      headers: {
        'x-default-user': 'mallory',
        authorization: basicHeader('admin', 'admin123'),
      },
    })

    expect(res.status).toBe(200)
    // Both, in the order the decorator named them.
    expect(((await res.json()) as { types: string[] }).types).toEqual(['Default', 'Basic'])
  })

  it('still authenticates when only one of the named schemes is satisfied', async () => {
    @Authorize({ schemes: ['Default', 'Basic'] })
    @Controller('/either-scheme')
    class EitherSchemeController {
      @Get('/')
      @Args([$p.context()])
      read(ctx: Context) {
        return { types: ctx.user.identities.map(i => i.authenticationType) }
      }
    }
    void [EitherSchemeController]

    app = buildApp()
    await app.ready()

    const res = await app.fetch('/either-scheme', { headers: { authorization: basicHeader('admin', 'admin123') } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { types: string[] }).types).toEqual(['Basic'])
  })

  // The schemes are the inner level's to choose: naming some on a method replaces the controller's, it does not add
  // to them. That is the only way a route can refuse a credential its controller accepts — a state-changing route
  // taking a token and not the session cookie every other route of the controller takes.
  it('lets a method accept fewer schemes than its controller does', async () => {
    @Authorize({ schemes: ['Default', 'Basic'] })
    @Controller('/narrowed')
    class NarrowedController {
      @Get('/either')
      read() {
        return { ok: true }
      }

      @Get('/basic-only')
      @Authorize({ schemes: ['Basic'] })
      write() {
        return { ok: true }
      }
    }
    void [NarrowedController]

    app = buildApp()
    await app.ready()

    const withDefault = { headers: { 'x-default-user': 'mallory' } }

    expect((await app.fetch('/narrowed/either', withDefault)).status).toBe(200)

    const refused = await app.fetch('/narrowed/basic-only', withDefault)
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('Basic realm="Docs", charset="UTF-8"')

    const withBasic = { headers: { authorization: basicHeader('admin', 'admin123') } }
    expect((await app.fetch('/narrowed/basic-only', withBasic)).status).toBe(200)
  })

  it('refuses to start when a route names a scheme that was never registered', async () => {
    // Silently, this produced a route that rejected every caller: the unknown name authenticated nobody, so
    // the principal was reset to anonymous and authorization denied — with nothing anywhere naming the typo.
    @Authorize({ schemes: ['Beaerer'] })
    @Controller('/typo')
    class TypoSchemeController {
      @Get('/')
      read() {
        return { ok: true }
      }
    }
    void [TypoSchemeController]

    app = buildApp()
    await expect(app.ready()).rejects.toThrow(/Beaerer/)
  })
})
