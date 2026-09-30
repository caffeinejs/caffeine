import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  Authorize,
  BaseAuthenticationHandler,
  Controller,
  Get,
  createWebApplication,
} from '../../index.js'

/**
 * The whole-table scheme check: a route naming a scheme the feature never registered is a start-up failure,
 * with or without a gate — it used to fire only from the gate's own `onRoute` hook.
 *
 * Its own file: the `@Authorize({ schemes })` controller registers into the process-global registry, and every
 * application built after it in the same module would have to know the ghost scheme.
 */

class AlwaysAnonymous extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(): Promise<AuthenticateResult> {
    return AuthenticateResult.none()
  }
}

@Authorize({ schemes: ['Ghost'] })
@Controller('/ghost-scheme')
class GhostSchemeController {
  @Get('/')
  list() {
    return { ok: true }
  }
}
void [GhostSchemeController]

describe('route scheme resolution', () => {
  it('refuses a route naming an unregistered scheme even with no gate registered', async () => {
    const app = createWebApplication().install(
      Authentication(auth => auth.addStrategy('Real', new AlwaysAnonymous()).default('Real')),
    )

    await expect(app.bootstrap()).rejects.toMatchObject({ code: 'ERR_AUTH_SCHEME_NOT_FOUND' })
  })
})
