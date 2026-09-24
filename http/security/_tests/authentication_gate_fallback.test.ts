import { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  type Context,
  Identity,
  Principal,
  createWebApplication,
  health,
  authenticationExempt,
  newRouter,
} from '../../index.js'

/**
 * The authentication gate in front of routes the application's router did not compile, and the ways a route stays
 * out of its reach. Routers and plain Fastify routes only: a controller registers globally, and these
 * applications turn on a policy that gates whatever declares nothing.
 */

class HeaderScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
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

function plainRoutes() {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.get('/admin-ui/users', ok)
        instance.get('/assets/app.js', ok)
        instance.get('/assets-but-not-really', ok)
        instance.get('/metrics', { config: authenticationExempt() }, async request => ({
          user: request.user,
        }))
      },
      { name: 'plain-routes' },
    )
}

describe('the authentication gate and routes registered straight on the server', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Mounting a router re-types the application with its routes, so what is kept is the way to close it.
  async function ready<A extends { ready(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.ready()

    return app
  }

  const signedIn = { headers: { 'x-user': 'alice' } }

  it('leaves them open when the application set no fallback policy', async () => {
    const app = await ready(
      createWebApplication()
        .authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
        .with(plainRoutes()),
    )

    expect((await app.fetch('/admin-ui/users')).status).toBe(200)
  })

  describe('under a fallback policy', () => {
    function build() {
      return ready(
        createWebApplication()
          .authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
          .authorization(authz => authz.requireAuthenticatedByDefault({ except: ['/assets/'] }))
          .with(health())
          .with(plainRoutes())
          .mount(newRouter('/compiled').get('/', ok)),
      )
    }

    // No decorator exists on such a route for anyone to forget, so nothing else would stand in front of it.
    it('gates them as it gates a compiled route that declares nothing', async () => {
      const running = await build()

      expect((await running.fetch('/compiled')).status).toBe(401)
      expect((await running.fetch('/admin-ui/users')).status).toBe(401)
      expect((await running.fetch('/admin-ui/users', signedIn)).status).toBe(200)
    })

    it('leaves open the prefixes the application excepted, matched on the path the route was registered under', async () => {
      const running = await build()

      expect((await running.fetch('/assets/app.js')).status).toBe(200)
      expect((await running.fetch('/assets-but-not-really')).status).toBe(401)
    })

    it('does not run at all for a route marked exempt, so no principal is established either', async () => {
      const running = await build()
      const response = await running.fetch('/metrics', signedIn)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ user: null })
    })

    it('leaves the health probes to the orchestrator', async () => {
      const running = await build()

      expect((await running.fetch('/livez')).status).toBe(200)
      // Not ready, since this application is never run — and that is the probe's own answer, not the gate's.
      expect((await running.fetch('/readyz')).status).toBe(503)
    })

    // The not-found handler is where a single-page application's shell is served from.
    it('answers 404, not 401, for a URL no route matches', async () => {
      const running = await build()

      expect((await running.fetch('/no-such-route')).status).toBe(404)
    })

    // The not-found context is the one route config no `onRoute` hook reaches, so the gate finds no `$caffeine`
    // on it and falls through to the policy, which excuses it. Authenticating is the half that must survive: the
    // handler answering an unmatched URL is where the shell is served, and it renders a signed-in caller
    // differently from an anonymous one.
    it('still establishes a principal for a URL no route matches', async () => {
      const app = await ready(
        createWebApplication()
          .authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
          .authorization(authz => authz.requireAuthenticatedByDefault())
          .with(() =>
            fp(
              async (instance: FastifyInstance) => {
                instance.setNotFoundHandler(async request => ({ user: request.user.authenticated }))
              },
              { name: 'echoing-not-found' },
            ),
          ),
      )

      expect(await (await app.fetch('/no-such-route', signedIn)).json()).toEqual({ user: true })
      expect(await (await app.fetch('/no-such-route')).json()).toEqual({ user: false })
    })
  })

  // A probe used to run the default scheme like any other request, so a scheme that was failing made the
  // orchestrator see a 500 and restart a process that was in fact alive.
  it('keeps a failing authentication scheme away from the health probes', async () => {
    const app = await ready(
      createWebApplication()
        .authentication(auth => auth.addStrategy('Broken', new BrokenScheme()))
        .with(health())
        .mount(newRouter('/compiled').get('/', ok)),
    )

    expect((await app.fetch('/compiled')).status).toBe(500)
    expect((await app.fetch('/livez')).status).toBe(200)
  })

  // A prefix is a run of whole path segments. Read as a run of characters, `/assets` would also open
  // `/assets-but-not-really`, which nobody who wrote `/assets` meant to leave unguarded.
  it('excepts whole path segments, so a prefix written without its trailing slash opens no neighbour', async () => {
    const app = await ready(
      createWebApplication()
        .authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
        .authorization(authz => authz.requireAuthenticatedByDefault({ except: ['/assets', '/admin-ui/users'] }))
        .with(plainRoutes()),
    )

    expect((await app.fetch('/assets/app.js')).status).toBe(200)
    expect((await app.fetch('/assets-but-not-really')).status).toBe(401)
    // The prefix itself is a path too.
    expect((await app.fetch('/admin-ui/users')).status).toBe(200)
  })

  // The server takes the base path off a request before routing, so a route is registered where the application
  // declared it, and an excepted prefix is written the way the application writes its routes: without the base.
  it('matches excepted prefixes relative to the application under a base path', async () => {
    const app = await ready(
      createWebApplication()
        .basePath('/api')
        .authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
        .authorization(authz => authz.requireAuthenticatedByDefault({ except: ['/assets'] }))
        .with(health())
        .with(plainRoutes()),
    )

    expect((await app.fetch('/api/assets/app.js')).status).toBe(200)
    expect((await app.fetch('/api/admin-ui/users')).status).toBe(401)
    expect((await app.fetch('/api/admin-ui/users', signedIn)).status).toBe(200)
    // The probes are still the orchestrator's.
    expect((await app.fetch('/api/livez')).status).not.toBe(401)
  })

  it('refuses a path to except that is not absolute', () => {
    const building = createWebApplication()

    expect(() => building.authorization(authz => authz.requireAuthenticatedByDefault({ except: ['assets/'] }))).toThrow(
      expect.objectContaining({ code: 'ERR_AUTHZ_FALLBACK_EXCEPT' }),
    )
  })
})

describe('the challenge of a route that names several schemes', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Mounting a router re-types the application with its routes, so what is kept is the way to close it.
  async function ready<A extends { ready(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.ready()

    return app
  }

  const secret = 'a-session-secret-of-at-least-32-characters'

  function build(schemes: string[]) {
    return ready(
      createWebApplication()
        .authentication(auth =>
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
        )
        .mount(newRouter('/named').authorize({ schemes }).get('/', ok)),
    )
  }

  // RFC 9110 §11.6.1: a client picks the challenge it can answer, so it has to be shown all of them. Each
  // scheme used to set the header, and the last one to write won.
  it('advertises every one of them', async () => {
    const app = await build(['Basic', 'Bearer'])

    const response = await app.fetch('/named')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Docs", charset="UTF-8", Bearer')
  })

  // The third value is appended to a header that already holds two, which is no longer a string to add to.
  it('loses none of them when there are more than two', async () => {
    const app = await build(['Basic', 'Bearer', 'Key'])

    const response = await app.fetch('/named')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      'Basic realm="Docs", charset="UTF-8", Bearer, ApiKey realm="Keys"',
    )
  })

  it('stops at the scheme that answers with a redirect, instead of turning it back into a 401', async () => {
    const app = await build(['Cookie', 'Basic'])

    const response = await app.fetch('/named', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?returnUrl=%2Fnamed')
    expect(response.headers.get('www-authenticate')).toBeNull()
  })

  it('still advertises the schemes listed before the one that answers the request itself', async () => {
    const app = await build(['Basic', 'Cookie'])

    const response = await app.fetch('/named', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })

    expect(response.status).toBe(302)
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Docs", charset="UTF-8"')
  })
})

describe('an application whose scheme reads cookies', () => {
  const secret = 'a-session-secret-of-at-least-32-characters'

  // The adapter registers @fastify/cookie before any plugin, so the parsing is in place whatever slot the gate
  // lands in. Ordering this by hand used to be the application's job, and getting it wrong was a TypeError on
  // every request.
  it('starts with nothing registered by the application', async () => {
    const app = createWebApplication().authentication(auth => auth.addCookie(c => c.sessionSecret(secret)))

    await expect(app.ready()).resolves.toBeUndefined()
    await app.close()
  })

  it('parses the cookies of a request reaching a route registered before authentication', async () => {
    const app = createWebApplication()
      .with(() =>
        fp(
          async (instance: FastifyInstance) => {
            instance.get('/seen', request => ({ seen: request.cookies.probe ?? null }))
          },
          { name: 'early-route' },
        ),
      )
      .authentication(auth => auth.addCookie(c => c.sessionSecret(secret)))

    await app.ready()

    const response = await app.fetch('/seen', { headers: { cookie: 'probe=yes' } })

    expect(await response.json()).toEqual({ seen: 'yes' })
    await app.close()
  })

  it('asks nothing of an application whose schemes read no cookie', async () => {
    const app = createWebApplication().authentication(auth => auth.addBasic(b => b.validate(() => null)))

    await expect(app.ready()).resolves.toBeUndefined()
    await app.close()
  })
})
