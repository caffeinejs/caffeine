import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  Authorization,
  BaseAuthenticationHandler,
  Claim,
  type Context,
  Identity,
  Principal,
  authentication,
  createWebApplication,
} from '../../index.js'
import { newRouter } from '../../routing/programmatic/new_router.js'

/**
 * How the gate registers: once at the root, per route group, or both — and how it fails when the feature it
 * runs on was never installed.
 *
 * Programmatic routers only: a `@Controller` registers into the process-global registry and would leak into
 * every application this file builds after it.
 */

/** Authenticates any request carrying `header`, and counts what the gate asked of it. */
class HeaderSchemeHandler extends BaseAuthenticationHandler<object> {
  challenges = 0

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

    const principal = new Principal(true, [new Identity(this.scheme, true, [new Claim('sub', user, '')])])

    return AuthenticateResult.success(new AuthenticationTicket(principal, this.scheme))
  }

  override async challenge(ctx: Context): Promise<void> {
    this.challenges++
    ctx.status(401).header('x-challenged-by', this.scheme)
  }
}

function schemes() {
  return { a: new HeaderSchemeHandler('A', 'x-a'), b: new HeaderSchemeHandler('B', 'x-b') }
}

describe('gate registration', () => {
  it('refuses a gate whose feature was never installed, at bootstrap', async () => {
    const app = createWebApplication().with(authentication())

    await expect(app.bootstrap()).rejects.toMatchObject({
      code: 'ERR_FEATURE_NOT_INSTALLED',
      message: expect.stringMatching(/Cannot use feature "auth": it is not installed/),
    })
  })

  it('refuses a gate default scheme nothing registered, at bootstrap', async () => {
    const { a } = schemes()
    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('A', a).default('A')))
      .with(authentication(g => g.defaultScheme('Missing')))

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTH_SCHEME_NOT_FOUND' })
  })

  it('refuses two root gates under the default label', async () => {
    const { a } = schemes()
    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('A', a).default('A')))
      .with(authentication())
      .with(authentication())

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_HTTP_DUPLICATE_PLUGIN' })
  })

  // A scoped chain inherits the root's registered plugin names, so a scoped gate under a root one must carry
  // its own label — explicitly, rather than silently authenticating every request twice.
  it('refuses a default-label scoped gate under a root gate', async () => {
    const { a } = schemes()
    const guarded = newRouter('/dup-scoped')
      .plugin(authentication())
      .get('/', () => ({ ok: true }))

    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('A', a).default('A')))
      .with(authentication())
      .mount(guarded)

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_HTTP_DUPLICATE_PLUGIN' })
  })

  // The ownership model: each gate stamps the routes its context registers and the innermost stamp wins, so a
  // route is authenticated and challenged exactly once, by the gate closest to it — with that gate's own
  // default scheme.
  it('lets a named scoped gate own its group, under a root gate with a different default', async () => {
    const { a, b } = schemes()
    const open = newRouter('/multi-root').get('/', () => ({ ok: true }))
    const admin = newRouter('/multi-admin')
      .plugin(authentication(g => g.name('admin').defaultScheme('B')))
      .get('/', () => ({ ok: true }))

    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('A', a).addStrategy('B', b).default('A')))
      .install(Authorization(z => z.requireAuthenticatedByDefault()))
      .with(authentication())
      .mount(open, admin)

    try {
      await app.bootstrap()

      // The root gate's territory: challenged once, by the application default.
      const root = await app.fetch('/multi-root')
      expect(root.status).toBe(401)
      expect(root.headers.get('x-challenged-by')).toBe('A')

      // The scoped gate's territory: the root gate stands down, so one challenge, by the gate's own default.
      const scoped = await app.fetch('/multi-admin')
      expect(scoped.status).toBe(401)
      expect(scoped.headers.get('x-challenged-by')).toBe('B')

      expect(a.challenges).toBe(1)
      expect(b.challenges).toBe(1)

      // The scoped default also authenticates: a B credential passes where the application default is A.
      expect((await app.fetch('/multi-admin', { headers: { 'x-b': 'admin-user' } })).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // With no root gate, only the gated group is guarded: a scoped gate's hooks never see the routes outside its
  // context. The open route declares nothing — under a fallback policy it would be protected, and start-up would
  // refuse it for having no gate over it.
  it('guards only the gated group when every gate is scoped', async () => {
    const { a } = schemes()
    const open = newRouter('/scoped-only-open').get('/', () => ({ ok: true }))
    const gated = newRouter('/scoped-only-gated')
      .plugin(authentication())
      .authorize()
      .get('/', () => ({ ok: true }))

    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('A', a).default('A')))
      .mount(open, gated)

    try {
      await app.bootstrap()

      expect((await app.fetch('/scoped-only-open')).status).toBe(200)
      expect((await app.fetch('/scoped-only-gated')).status).toBe(401)
      expect((await app.fetch('/scoped-only-gated', { headers: { 'x-a': 'user' } })).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // Installing the feature without any gate is a supported configuration: the services bind, nothing guards.
  it('serves ungated with the feature installed and no gate registered', async () => {
    const { a } = schemes()
    const open = newRouter('/feature-no-gate').get('/', () => ({ ok: true }))

    const app = createWebApplication()
      .install(Authentication(auth => auth.addStrategy('A', a).default('A')))
      .mount(open)

    try {
      await app.bootstrap()

      expect(app.instance.$hasFeature('auth')).toBe(true)
      expect((await app.fetch('/feature-no-gate')).status).toBe(200)
    } finally {
      await app.close()
    }
  })
})
