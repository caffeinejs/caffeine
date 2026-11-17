import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../../application.js'
import {
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  type IContext,
  Identity,
  Principal,
  Authentication,
  Authorization,
  CookieAuthenticationHandler,
  CookieAuthenticationOptionsBuilder,
  ErrAuthenticationCookies,
} from '../../../index.js'
import { node } from '../../../platform/node/index.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../../plugin.js'
import { healthProbes } from '../../health/index.js'
import { Router } from '../../routing/programmatic/programmatic.js'
import { accessControlExempt } from '../exempt.js'
import { authentication } from '../security.js'

/**
 * The authentication gate in front of routes a plugin mounted rather than the application, and the ways a route stays
 * out of its reach. Routers only: a controller registers globally, and these applications turn on a policy that gates
 * whatever declares nothing.
 */

class HeaderScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    const user = ctx.req.header('x-user')
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const principal = new Principal(true, new Identity('Header', true, [new Claim('sub', user, '')]))
    return AuthenticateResult.success(new AuthenticationTicket(principal, 'Header'))
  }
}

/** Fails the way a scheme does when what it depends on is down. */
class BrokenScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  authenticate(): Promise<AuthenticateResult> {
    return Promise.reject(new Error('the session store is unreachable'))
  }
}

const ok = () => ({ ok: true })

/** Routes a plugin mounts from its own slot, one of them exempt from access control. */
class PlainRoutes extends HTTPPlugin {
  override readonly name = 'plain-routes'

  register({ app }: HTTPSetupContext): void {
    app.mount(
      new Router().get('/admin-ui/users', ok).get('/assets/app.js', ok).get('/assets-but-not-really', ok),
      new Router('/metrics').extend(accessControlExempt()).get('/', ctx => ({ user: ctx.user })),
    )
  }
}

describe('the authentication gate and routes a plugin mounted', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Mounting a router re-types the application with its routes, so what is kept is the way to close it.
  async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.bootstrap()

    return app
  }

  const signedIn = { headers: { 'x-user': 'alice' } }

  it('leaves them open when the application set no fallback policy', async () => {
    const app = await ready(
      createWebApplication({ adapter: node() })
        .install(Authentication(auth => auth.addStrategy('Header', new HeaderScheme())))
        .with(authentication())
        .with(() => new PlainRoutes()),
    )

    expect((await app.request('/admin-ui/users')).status).toBe(200)
  })

  describe('under a fallback policy', () => {
    function build() {
      return ready(
        createWebApplication({ adapter: node() })
          .install(Authentication(auth => auth.addStrategy('Header', new HeaderScheme())))
          .with(authentication())
          .install(Authorization(authz => authz.requireAuthenticatedByDefault()))
          .with(healthProbes())
          .with(() => new PlainRoutes())
          .mount(new Router('/compiled').get('/', ok)),
      )
    }

    // No decorator exists on such a route for anyone to forget, so nothing else would stand in front of it.
    it('gates them as it gates a compiled route that declares nothing', async () => {
      const running = await build()

      expect((await running.request('/compiled')).status).toBe(401)
      expect((await running.request('/admin-ui/users')).status).toBe(401)
      expect((await running.request('/admin-ui/users', signedIn)).status).toBe(200)
    })

    it('does not run at all for a route marked exempt, so no principal is established either', async () => {
      const running = await build()
      const response = await running.request('/metrics', signedIn)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ user: null })
    })

    it('leaves the health probes to the orchestrator', async () => {
      const running = await build()

      expect((await running.request('/livez')).status).toBe(200)
      // Not ready, since this application is never run — and that is the probe's own answer, not the gate's.
      expect((await running.request('/readyz')).status).toBe(503)
    })

    // The not-found handler is where a single-page application's shell is served from.
    it('answers 404, not 401, for a URL no route matches', async () => {
      const running = await build()

      expect((await running.request('/no-such-route')).status).toBe(404)
    })
  })

  // A probe used to run the default scheme like any other request, so a scheme that was failing made the
  // orchestrator see a 500 and restart a process that was in fact alive.
  it('keeps a failing authentication scheme away from the health probes', async () => {
    const app = await ready(
      createWebApplication({ adapter: node() })
        .install(Authentication(auth => auth.addStrategy('Broken', new BrokenScheme())))
        .with(authentication())
        .with(healthProbes())
        .mount(new Router('/compiled').get('/', ok)),
    )

    expect((await app.request('/compiled')).status).toBe(500)
    expect((await app.request('/livez')).status).toBe(200)
  })
})

describe('the challenge of a route that names several schemes', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Mounting a router re-types the application with its routes, so what is kept is the way to close it.
  async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.bootstrap()

    return app
  }

  const secret = 'a-session-secret-of-at-least-32-characters'

  function build(schemes: string[]) {
    return ready(
      createWebApplication({ adapter: node() })
        .install(
          Authentication(auth =>
            auth
              .addBasic(b => b.realm('Docs').validate(() => null))
              .addJWTBearer(j => j.secret(secret).issuer('issuer').audience('audience'))
              .addCookie(c => c.sessionSecret(secret).secure(false).loginPath('/login'))
              .addOpaqueToken('Key', o =>
                o
                  .scheme('ApiKey')
                  .realm('Keys')
                  .store({ validate: () => null }),
              )
              .default('Bearer'),
          ),
        )
        .with(authentication())
        .mount(new Router('/named').authorize({ schemes }).get('/', ok)),
    )
  }

  // RFC 9110 §11.6.1: a client picks the challenge it can answer, so it has to be shown all of them. Each
  // scheme used to set the header, and the last one to write won.
  it('advertises every one of them', async () => {
    const app = await build(['Basic', 'Bearer'])

    const response = await app.request('/named')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Docs", charset="UTF-8", Bearer')
  })

  // The third value is appended to a header that already holds two, which is no longer a string to add to.
  it('loses none of them when there are more than two', async () => {
    const app = await build(['Basic', 'Bearer', 'Key'])

    const response = await app.request('/named')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      'Basic realm="Docs", charset="UTF-8", Bearer, ApiKey realm="Keys"',
    )
  })

  it('stops at the scheme that answers with a redirect, instead of turning it back into a 401', async () => {
    const app = await build(['Cookie', 'Basic'])

    const response = await app.request('/named', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?returnUrl=%2Fnamed')
    expect(response.headers.get('www-authenticate')).toBeNull()
  })

  it('still advertises the schemes listed before the one that answers the request itself', async () => {
    const app = await build(['Basic', 'Cookie'])

    const response = await app.request('/named', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })

    expect(response.status).toBe(302)
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Docs", charset="UTF-8"')
  })
})

describe('an application whose scheme reads cookies', () => {
  const secret = 'a-session-secret-of-at-least-32-characters'

  // Cookies are parsed when first read, so whatever slot the gate lands in finds them. Ordering this by hand used to
  // be the application's job, and getting it wrong was a TypeError on every request.
  it('starts with nothing registered by the application', async () => {
    const app = createWebApplication({ adapter: node() })
      .install(Authentication(auth => auth.addCookie(c => c.sessionSecret(secret))))
      .with(authentication())

    await expect(app.bootstrap()).resolves.toBeUndefined()
    await app.close()
  })

  it('parses the cookies of a request reaching a route registered before authentication', async () => {
    const app = createWebApplication({ adapter: node() })
      .with(
        () =>
          new (class extends HTTPPlugin {
            override readonly name = 'early-route'

            register({ app }: HTTPSetupContext): void {
              app.mount(new Router().get('/seen', ctx => ({ seen: ctx.req.cookie('probe') ?? null })))
            }
          })(),
      )
      .install(Authentication(auth => auth.addCookie(c => c.sessionSecret(secret))))
      .with(authentication())

    await app.bootstrap()

    const response = await app.request('/seen', { headers: { cookie: 'probe=yes' } })

    expect(await response.json()).toEqual({ seen: 'yes' })
    await app.close()
  })

  // Every request carrying the session cookie would fail to read it, so the server does not start.
  it('refuses to start a cookie scheme on a server whose cookies are off', async () => {
    const app = createWebApplication({ adapter: node() })
      .cookie(k => k.enabled(false))
      .install(Authentication(auth => auth.addCookie(c => c.sessionSecret(secret))))
      .with(authentication())

    await expect(app.bootstrap()).rejects.toMatchObject({
      name: 'ErrAuthenticationCookies',
      message: expect.stringContaining('authentication scheme "Cookie" keeps its session in a cookie'),
    })
    await app.close()
  })

  it('refuses a cookie scheme handed over built, too', async () => {
    const handler = new CookieAuthenticationHandler(
      'session',
      new CookieAuthenticationOptionsBuilder().sessionSecret(secret).build(),
    )
    const app = createWebApplication({ adapter: node() })
      .cookie(k => k.enabled(false))
      .install(Authentication(auth => auth.addStrategy('session', handler)))
      .with(authentication())

    await expect(app.bootstrap()).rejects.toBeInstanceOf(ErrAuthenticationCookies)
    await app.close()
  })

  it('asks nothing of an application whose schemes read no cookie', async () => {
    const app = createWebApplication({ adapter: node() })
      .cookie(k => k.enabled(false))
      .install(Authentication(auth => auth.addBasic(b => b.validate(() => null))))
      .with(authentication())

    await expect(app.bootstrap()).resolves.toBeUndefined()
    await app.close()
  })
})
