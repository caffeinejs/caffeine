import { describe, it, expect } from 'vitest'

import {
  AuthenticationService,
  Authorize,
  Controller,
  ErrAuthenticationRequired,
  ErrAuthorizationRequired,
  Get,
  createWebApplication,
} from '../index.js'

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
    await app.ready()

    const res = await app.fetch('/authz-none-needed')
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
    await app.ready()

    const res = await app.fetch('/authz-standalone')
    expect(res.status).toBe(200)
  })

  // Authentication is checked first (see `fastify_adapter.ts`), so a protected route with neither feature configured
  // is refused with the authentication-specific error — calling `.authentication(...)` would also auto-install
  // authorization, so that is the one actionable fix. This is unaffected by the authorization changes; it is
  // asserted here as a regression guard alongside the narrower authorization-only case below.
  it('rejects ready() with the authentication error when a route is protected and neither is configured', async () => {
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

    await expect(app.ready()).rejects.toThrow(ErrAuthenticationRequired)
  })

  // The only way to reach `ErrAuthorizationRequired` itself: authentication bound directly on the container,
  // bypassing `.authentication(...)` entirely, so the auto-install in `WebApplication.ready()` never runs.
  it('rejects ready() with ErrAuthorizationRequired when authentication is bound without going through .authentication()', async () => {
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

    await expect(app.ready()).rejects.toThrow(ErrAuthorizationRequired)
  })
})
