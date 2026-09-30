import { type FastifyInstance, type RouteShorthandOptions } from 'fastify'
import fp from 'fastify-plugin'
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
  authenticationExempt,
  createWebApplication,
  healthProbes,
  newRouter,
} from '../../index.js'

/**
 * Which routes start-up refuses for want of an authentication gate. Installing `Authentication(...)` binds what
 * a gate runs on, but only a gate authenticates a request, so a route it would authorize — declared protected, or
 * reached by the fallback policy — must have one over it. A gate covers the context it installed on and every
 * context beneath it, whatever order they were created in, so where it sits among the plugins never decides.
 *
 * Programmatic routers and plain Fastify routes only: a `@Controller` registers into the process-global registry
 * and would leak into every application this file builds after it.
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

const ok = () => ({ ok: true })
const signedIn = { headers: { 'x-user': 'alice' } }
const header = () => Authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
const byDefault = () => Authorization(authz => authz.requireAuthenticatedByDefault())

/** A route registered straight on the root server, from a `fastify-plugin`-wrapped plugin. */
function rootRoute(path: string, options: RouteShorthandOptions = {}) {
  return () =>
    fp(
      async (instance: FastifyInstance) => {
        instance.get(path, options, ok)
      },
      { name: `root-route:${path}` },
    )
}

/** A route registered in a context of its own: the plugin is not wrapped in `fastify-plugin`. */
function childRoute(path: string) {
  return () => async (instance: FastifyInstance) => {
    instance.get(path, ok)
  }
}

/** What bootstrap rejected with. */
async function refusal(app: { bootstrap(): Promise<unknown> }): Promise<Error & { code?: string }> {
  return app.bootstrap().then(
    () => expect.unreachable('bootstrap should have been refused'),
    (err: unknown) => err as Error & { code?: string },
  )
}

describe('routes no authentication gate covers', () => {
  it('refuses a protected route when the feature is installed and no gate is registered', async () => {
    const app = createWebApplication().install(header()).mount(newRouter('/no-gate').authorize().get('/', ok))

    const err = await refusal(app)

    expect(err.code).toBe('ERR_AUTHENTICATION_GATE_REQUIRED')
    expect(err.message).toMatch(
      /^Cannot start application: route "GET\|HEAD \/no-gate" requires authentication and no authentication gate covers it/,
    )
  })

  // A scoped gate reaches its own router and nothing beside it.
  it('refuses a protected route outside the only gated router, naming that route alone', async () => {
    const gated = newRouter('/sibling-gated').plugin(authentication()).authorize().get('/', ok)
    const bare = newRouter('/sibling-bare').authorize().get('/', ok)

    const err = await refusal(createWebApplication().install(header()).mount(gated, bare))

    expect(err.code).toBe('ERR_AUTHENTICATION_GATE_REQUIRED')
    expect(err.message).toContain('"GET|HEAD /sibling-bare"')
    expect(err.message).not.toContain('/sibling-gated')
  })

  // The fallback policy protects every route that declares nothing, so with every gate scoped, what lies outside
  // them would be served to anyone — a route compiled from a router and one registered straight on the server alike.
  it('refuses what the fallback policy protects outside every scoped gate', async () => {
    const gated = newRouter('/fallback-gated').plugin(authentication()).get('/', ok)
    const open = newRouter('/fallback-open').get('/', ok)

    const app = createWebApplication()
      .install(header())
      .install(byDefault())
      .with(rootRoute('/fallback-raw'))
      .mount(gated, open)

    const err = await refusal(app)

    expect(err.code).toBe('ERR_AUTHENTICATION_GATE_REQUIRED')
    expect(err.message).toContain('"GET|HEAD /fallback-raw"')
    expect(err.message).toContain('"GET|HEAD /fallback-open"')
    expect(err.message).not.toContain('/fallback-gated')
  })

  // A gate's request hook reaches every context beneath the one it installed on, including those created before
  // it: an unwrapped plugin registered ahead of the root gate is still behind it, so starting is right.
  it('lets a route registered before the root gate through, and gates it', async () => {
    const app = createWebApplication()
      .install(header())
      .install(byDefault())
      .with(childRoute('/early-child'))
      .with(rootRoute('/early-root'))
      .with(authentication())

    try {
      await app.bootstrap()

      expect((await app.fetch('/early-child')).status).toBe(401)
      expect((await app.fetch('/early-child', signedIn)).status).toBe(200)
      expect((await app.fetch('/early-root')).status).toBe(401)
      expect((await app.fetch('/early-root', signedIn)).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('starts with no gate at all when nothing a gate would authorize is left', async () => {
    const app = createWebApplication()
      .install(header())
      .install(byDefault())
      .with(healthProbes())
      .with(rootRoute('/exempt', { config: authenticationExempt() }))
      .mount(newRouter('/anonymous').authorize({ allowAnonymous: true }).get('/', ok))

    try {
      await app.bootstrap()

      expect((await app.fetch('/anonymous')).status).toBe(200)
      expect((await app.fetch('/exempt')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // No gate can be registered without the feature, so the missing feature is the fix to name.
  it('names the missing feature when a fallback policy protects a route and authentication was never installed', async () => {
    const app = createWebApplication().install(byDefault()).with(rootRoute('/unauthenticated'))

    expect((await refusal(app)).code).toBe('ERR_AUTHENTICATION_REQUIRED')
  })

  // A plugin's `onRoute` hook can drop what the adapter put on the route. The gate cannot claim it then, but the
  // route still registers, and the fallback policy still answers it.
  it('keeps a route another hook stripped of its Caffeine config behind the gate', async () => {
    const strip = () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('onRoute', route => {
            if (route.url === '/stripped') {
              delete route.config?.$caffeine
            }
          })
        },
        { name: 'strip-caffeine' },
      )

    const app = createWebApplication()
      .install(header())
      .install(byDefault())
      .with(strip)
      .with(authentication())
      .with(rootRoute('/stripped'))

    try {
      await app.bootstrap()

      expect((await app.fetch('/stripped')).status).toBe(401)
      expect((await app.fetch('/stripped', signedIn)).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('names the first five uncovered routes and counts the rest', async () => {
    const bare = newRouter('/many')
      .authorize()
      .get('/r0', ok)
      .get('/r1', ok)
      .get('/r2', ok)
      .get('/r3', ok)
      .get('/r4', ok)
      .get('/r5', ok)
      .get('/r6', ok)

    const err = await refusal(createWebApplication().install(header()).mount(bare))

    expect(err.message).toMatch(
      /^Cannot start application: routes "GET\|HEAD \/many\/r0", "GET\|HEAD \/many\/r1", "GET\|HEAD \/many\/r2", "GET\|HEAD \/many\/r3", "GET\|HEAD \/many\/r4" and 2 more require authentication and no authentication gate covers them/,
    )
  })
})
