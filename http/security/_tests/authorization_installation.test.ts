import { describe, it, expect } from 'vitest'

import {
  AllowAnonymous,
  AuthenticateResult,
  AuthenticationService,
  Authorize,
  BaseAuthenticationHandler,
  Controller,
  ErrAuthenticationRequired,
  ErrAuthorizationRequired,
  Get,
  createWebApplication,
} from '../../index.js'

// Kept in its own file, protected-route cases last: `WebApplication` snapshots the global `@Controller`
// registry at construction, and that registry only ever grows within a test file — so an `@Authorize`-
// decorated controller declared by an earlier test here would leak a protected route into a later test's app.

describe('authorization installation', () => {
  it('starts with no protected routes and neither authentication nor authorization configured', async () => {
    @Controller('/authz-none-needed')
    class NoneNeededController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [NoneNeededController]

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/authz-none-needed')
    expect(res.status).toBe(200)
  })

  // A route that only opts *out* declares no protection (`declaresAuthzProtection` in `routing/compile.ts`), so
  // it must not demand an authentication scheme.
  it('starts when the only authz decorator is @AllowAnonymous', async () => {
    @Controller('/authz-anon-only')
    class AnonOnlyController {
      @Get('/')
      @AllowAnonymous()
      list() {
        return { ok: true }
      }
    }
    void [AnonOnlyController]

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/authz-anon-only')
    expect(res.status).toBe(200)
  })

  it('installs authorization on its own, with no .authentication() call', async () => {
    @Controller('/authz-standalone')
    class StandaloneController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [StandaloneController]

    const app = createWebApplication()
    // Never named by a route: the policy is only there so `.authorization(...)` has something to install.
    app.authorization(authz => authz.addPolicy('SignedIn', p => p.requireAuthenticated()))
    await app.bootstrap()

    const res = await app.fetch('/authz-standalone')
    expect(res.status).toBe(200)
  })

  // Authentication is checked first (see `fastify_adapter.ts`), so a protected route with neither feature configured
  // is refused with the authentication-specific error — calling `.authentication(...)` would also auto-install
  // authorization, so that is the one actionable fix. This is unaffected by the authorization changes; it is
  // asserted here as a regression guard alongside the narrower authorization-only case below.
  it('rejects bootstrap() with the authentication error when a route is protected and neither is configured', async () => {
    @Authorize()
    @Controller('/authz-neither-configured')
    class NeitherConfiguredController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [NeitherConfiguredController]

    const app = createWebApplication()

    await expect(app.bootstrap()).rejects.toThrow(ErrAuthenticationRequired)
  })

  // The only way to reach `ErrAuthorizationRequired` itself: authentication bound directly on the container,
  // bypassing `.authentication(...)` entirely, so the auto-install in `beforeConfigure()` never runs.
  it('rejects bootstrap() with ErrAuthorizationRequired when authentication is bound without going through .authentication()', async () => {
    @Authorize()
    @Controller('/authz-bypassed')
    class BypassedController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [BypassedController]

    const app = createWebApplication()
    app.container.bind(AuthenticationService, t => t.toValue({} as AuthenticationService))

    await expect(app.bootstrap()).rejects.toThrow(ErrAuthorizationRequired)
  })

  // `.authentication()` inside the callback is still before the feature list is read, so the default
  // authorization policy is installed with it. Without that, `bootstrap()` fails with ErrAuthorizationRequired.
  it('installs authorization when .authentication() is called from the bootstrap() callback', async () => {
    @Authorize()
    @Controller('/authz-from-ready-callback')
    class FromCallbackController {
      @Get('/')
      list() {
        return { ok: true }
      }
    }
    void [FromCallbackController]

    class None extends BaseAuthenticationHandler<object> {
      authenticate(): Promise<AuthenticateResult> {
        return Promise.resolve(AuthenticateResult.none())
      }
    }

    const app = createWebApplication()
    await app.bootstrap((_config, application) => {
      application.authentication(auth => auth.addStrategy('default', new None({})).default('default'))
    })

    const res = await app.fetch('/authz-from-ready-callback')
    expect(res.status).toBe(401)
    await app.close()
  })
})
