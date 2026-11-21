import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../../../application.js'
import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  Authorization,
  BaseAuthenticationHandler,
  Claim,
  type IContext,
  Identity,
  Principal,
} from '../../../index.js'
import { node } from '../../../platform/node.testkit.js'
import { HTTPPlugin, type HTTPSetupContext } from '../../../plugin.js'
import { healthProbes } from '../../health/index.js'
import { Router } from '../../routing/programmatic/programmatic.js'
import { accessControlExempt } from '../exempt.js'
import { authentication } from '../security.js'

/**
 * Which routes start-up refuses for want of an authentication gate. Installing `Authentication(...)` binds what
 * a gate runs on, but only a gate authenticates a request, so a route it would authorize — declared protected, or
 * reached by the fallback policy — must have one over it. A gate covers the context it installed on and every
 * context beneath it, whatever order they were created in, so where it sits among the plugins never decides.
 *
 * Programmatic routers only: a `@Controller` registers into the process-global registry
 * and would leak into every application this file builds after it.
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

const ok = () => ({ ok: true })
const signedIn = { headers: { 'x-user': 'alice' } }
const header = () => Authentication(auth => auth.addStrategy('Header', new HeaderScheme()))
const byDefault = () => Authorization(authz => authz.requireAuthenticatedByDefault())

/** A route a plugin mounts from its own slot, registered wherever the plugin was written. */
function pluginRoute(path: string) {
  return () =>
    new (class extends HTTPPlugin {
      override readonly name = `plugin-route:${path}`

      register({ app }: HTTPSetupContext): void {
        app.mount(new Router(path).get('/', ok))
      }
    })()
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
    const app = createWebApplication({ adapter: node() })
      .install(header())
      .mount(new Router('/no-gate').authorize().get('/', ok))

    const err = await refusal(app)

    expect(err.code).toBe('ERR_AUTHENTICATION_GATE_REQUIRED')
    expect(err.message).toMatch(
      /^Cannot start application: route "GET\|HEAD \/no-gate" requires authentication and no authentication gate covers it/,
    )
  })

  // A scoped gate reaches its own router and nothing beside it.
  it('refuses a protected route outside the only gated router, naming that route alone', async () => {
    const gated = new Router('/sibling-gated').with(authentication()).authorize().get('/', ok)
    const bare = new Router('/sibling-bare').authorize().get('/', ok)

    const err = await refusal(createWebApplication({ adapter: node() }).install(header()).mount(gated, bare))

    expect(err.code).toBe('ERR_AUTHENTICATION_GATE_REQUIRED')
    expect(err.message).toContain('"GET|HEAD /sibling-bare"')
    expect(err.message).not.toContain('/sibling-gated')
  })

  // The fallback policy protects every route that declares nothing, so with every gate scoped, what lies outside
  // them would be served to anyone.
  it('refuses what the fallback policy protects outside every scoped gate', async () => {
    const gated = new Router('/fallback-gated').with(authentication()).get('/', ok)
    const open = new Router('/fallback-open').get('/', ok)

    const app = createWebApplication({ adapter: node() }).install(header()).install(byDefault()).mount(gated, open)

    const err = await refusal(app)

    expect(err.code).toBe('ERR_AUTHENTICATION_GATE_REQUIRED')
    expect(err.message).toContain('"GET|HEAD /fallback-open"')
    expect(err.message).not.toContain('/fallback-gated')
  })

  // The root gate covers every route of its server, including one a plugin written ahead of it mounted, so starting
  // is right.
  it('lets a route registered before the root gate through, and gates it', async () => {
    const app = createWebApplication({ adapter: node() })
      .install(header())
      .install(byDefault())
      .with(pluginRoute('/early-root'))
      .with(authentication())

    try {
      await app.bootstrap()

      expect((await app.request('/early-root')).status).toBe(401)
      expect((await app.request('/early-root', signedIn)).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('starts with no gate at all when nothing a gate would authorize is left', async () => {
    const app = createWebApplication({ adapter: node() })
      .install(header())
      .install(byDefault())
      .with(healthProbes())
      .mount(new Router('/exempt').routeOptions(accessControlExempt()).get('/', ok))
      .mount(new Router('/anonymous').authorize({ allowAnonymous: true }).get('/', ok))

    try {
      await app.bootstrap()

      expect((await app.request('/anonymous')).status).toBe(200)
      expect((await app.request('/exempt')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // No gate can be registered without the feature, so the missing feature is the fix to name.
  it('names the missing feature when a fallback policy protects a route and authentication was never installed', async () => {
    const app = createWebApplication({ adapter: node() })
      .install(byDefault())
      .mount(new Router('/unauthenticated').get('/', ok))

    expect((await refusal(app)).code).toBe('ERR_AUTHENTICATION_REQUIRED')
  })

  it('names the first five uncovered routes and counts the rest', async () => {
    const bare = new Router('/many')
      .authorize()
      .get('/r0', ok)
      .get('/r1', ok)
      .get('/r2', ok)
      .get('/r3', ok)
      .get('/r4', ok)
      .get('/r5', ok)
      .get('/r6', ok)

    const err = await refusal(createWebApplication({ adapter: node() }).install(header()).mount(bare))

    expect(err.message).toMatch(
      /^Cannot start application: routes "GET\|HEAD \/many\/r0", "GET\|HEAD \/many\/r1", "GET\|HEAD \/many\/r2", "GET\|HEAD \/many\/r3", "GET\|HEAD \/many\/r4" and 2 more require authentication and no authentication gate covers them/,
    )
  })
})
