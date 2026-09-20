import { type AuthorizationBuilder, newRouter } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { startApp, type E2EApplication } from './internal/app.js'
import { localJWT } from './internal/tokens.js'

/**
 * Declarations an application must refuse to start with. Each would otherwise be a route that silently means
 * something other than what was written on it: open when it reads as protected, or closed to everyone.
 *
 * Routers only, and a file of its own: a controller registers globally, so one declared here would ride along in
 * every application below and start-up would fail for a reason other than the one under test.
 */

const ok = () => ({ ok: true })

async function refusal(configure: (app: E2EApplication) => unknown): Promise<unknown> {
  try {
    const running = await startApp(configure)
    await running.close()
  } catch (error) {
    return error
  }

  throw new Error('The application started')
}

describe('an application that must not start', () => {
  it('protects a route and configures no authentication', async () => {
    const error = await refusal(app => app.mount(newRouter('/private').authorize({}).get('/', ok)))

    expect(error).toMatchObject({ code: 'ERR_AUTHENTICATION_REQUIRED' })
  })

  it('names a policy that was never registered', async () => {
    const error = await refusal(app =>
      app
        .authentication(auth => auth.addJWTBearer(localJWT))
        .authorization(authz => authz.addPolicy('engineering', p => p.requireAuthenticated()))
        .mount(newRouter('/private').authorize({ policy: 'enginering' }).get('/', ok)),
    )

    expect(error).toMatchObject({ code: 'ERR_AUTHZ_POLICY_NOT_FOUND' })
    expect(String((error as Error).message)).toContain('"enginering"')
    expect(String((error as Error).message)).toContain('"engineering"')
  })

  // A policy with no requirement is satisfied by everyone, the anonymous caller included.
  it.each([
    ['a named policy', (authz: AuthorizationBuilder) => authz.addPolicy('nothing', () => undefined)],
    [
      'the policy a bare @Authorize stands for',
      (authz: AuthorizationBuilder) => authz.authorizeDecoratorDefaultPolicy(() => undefined),
    ],
    ['the fallback policy', (authz: AuthorizationBuilder) => authz.fallbackPolicy(() => undefined)],
  ])('registers %s with no requirement in it', async (_label, configure) => {
    const error = await refusal(app =>
      app.authentication(auth => auth.addJWTBearer(localJWT)).authorization(authz => configure(authz)),
    )

    expect(error).toMatchObject({ code: 'ERR_AUTHZ_POLICY_EMPTY' })
  })

  it('names an authentication scheme that was never registered', async () => {
    const error = await refusal(app =>
      app
        .authentication(auth => auth.addJWTBearer(localJWT))
        .mount(
          newRouter('/private')
            .authorize({ schemes: ['Beaerer'] })
            .get('/', ok),
        ),
    )

    expect(error).toMatchObject({ code: 'ERR_AUTH_SCHEME_NOT_FOUND' })
    expect(String((error as Error).message)).toContain('"Beaerer"')
  })

  it('registers several schemes and says which is the default for none of them', async () => {
    const error = await refusal(app =>
      app.authentication(auth => auth.addJWTBearer(localJWT).addBasic(b => b.validate(() => null))),
    )

    expect(error).toMatchObject({ code: 'ERR_AUTH_CONFIGURATION' })
  })

  it('configures authentication with no scheme at all', async () => {
    const error = await refusal(app => app.authentication(auth => auth))

    expect(error).toMatchObject({ code: 'ERR_AUTH_CONFIGURATION' })
  })

  it('configures a JWT scheme that pins neither an issuer nor an audience', async () => {
    const error = await refusal(app =>
      app.authentication(auth => auth.addJWTBearer(j => j.secret('e2e-hs256-secret-with-more-than-32-bytes-of-text'))),
    )

    expect(String((error as Error).message)).toMatch(/an "issuer" is required/)
  })

  it('configures a cookie scheme whose secret is too short to derive a key from', async () => {
    const error = await refusal(app => app.authentication(auth => auth.addCookie(c => c.sessionSecret('too-short'))))

    expect(String((error as Error).message)).toMatch(/at least 32 characters/)
  })
})
