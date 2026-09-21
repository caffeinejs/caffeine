import { describe, it, expect } from 'vitest'

import {
  AuthenticateResult,
  Authorize,
  BaseAuthenticationHandler,
  type Context,
  Controller,
  Get,
  createWebApplication,
} from '../index.js'

/**
 * A route naming a scheme that nothing registered is a start-up failure — a typo must not become a route
 * that rejects every caller with nothing to point at.
 *
 * Its own file because `@Controller` registers into a global registry that every container snapshots when it
 * is constructed: a controller declared to break start-up breaks every application built after it in the
 * same file. Same reason as fallback_policy.test.ts.
 */

class NeverAuthenticates extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(_ctx: Context): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

@Authorize({ schemes: ['Typo'] })
@Controller('/mw-auth-typo')
class TypoController {
  @Get('/')
  list() {
    return { ok: true }
  }
}
void [TypoController]

describe('authentication extension — unknown scheme', () => {
  it('refuses to start when a route names a scheme nothing registered', async () => {
    const builder = createWebApplication()
    builder.authentication(auth => auth.addStrategy('Header', new NeverAuthenticates()).default('Header'))

    await expect(builder.ready()).rejects.toThrow('Cannot resolve authentication scheme "Typo"')
  })
})
