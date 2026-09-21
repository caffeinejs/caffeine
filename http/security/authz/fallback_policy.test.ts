import { afterEach, describe, expect, it } from 'vitest'

import {
  AllowAnonymous,
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  type Context,
  Controller,
  Get,
  Identity,
  Principal,
  WebApplication,
  createWebApplication,
} from '../../index.js'

/**
 * `fallbackPolicy` — the posture switch that makes an undecorated route protected rather than public.
 *
 * Its own file for the same reason as `authorization_configurer_open.test.ts`: `@Controller` registers into
 * a process-global registry at decoration time, so every application built in a module sees every
 * controller the module decorated. These tests turn on a policy that gates *undecorated* routes, which
 * would otherwise reach into any neighbouring test's controllers.
 */

class HeaderSchemeHandler extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const user = ctx.req.header('x-user')
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const principal = new Principal(true, [new Identity('Header', true, [new Claim('sub', user, '')])])

    return AuthenticateResult.success(new AuthenticationTicket(principal, 'Header'))
  }
}

@Controller('/undecorated')
class UndecoratedController {
  @Get('/')
  read() {
    return { ok: true }
  }
}

@Controller('/opted-out')
class OptedOutController {
  @AllowAnonymous()
  @Get('/')
  read() {
    return { ok: true }
  }
}
void [UndecoratedController, OptedOutController]

function buildApp(withFallback: boolean): WebApplication {
  const builder = createWebApplication()

  builder.authentication(auth => auth.addStrategy('Header', new HeaderSchemeHandler()).default('Header'))
  if (withFallback) {
    builder.authorization(authz => authz.requireAuthenticatedByDefault())
  }

  return builder as WebApplication
}

describe('fallbackPolicy', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close().catch(() => undefined)
      app = undefined
    }
  })

  it('leaves undecorated routes open when it is not configured', async () => {
    app = buildApp(false)
    await app.ready()

    expect((await app.fetch('/undecorated')).status).toBe(200)
  })

  it('gates an undecorated route once configured', async () => {
    // The whole point: forgetting `@Authorize` stops being the difference between a protected endpoint and
    // a public one.
    app = buildApp(true)
    await app.ready()

    expect((await app.fetch('/undecorated')).status).toBe(401)
    expect((await app.fetch('/undecorated', { headers: { 'x-user': 'alice' } })).status).toBe(200)
  })

  it('honours @AllowAnonymous as the opt-out', async () => {
    app = buildApp(true)
    await app.ready()

    expect((await app.fetch('/opted-out')).status).toBe(200)
  })
})
