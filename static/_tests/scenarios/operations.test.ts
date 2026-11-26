import {
  Catch,
  corsPolicy,
  ErrHTTPNotFound,
  healthProbes,
  HTTPPlugin,
  Router,
  type ActionResult,
  type HTTPPluginFactory,
  type ErrorHandler,
  type HTTPSetupContext,
  type IContext,
  type AnyRouter,
  createWebApplication,
  type WebApplication,
} from '@caffeinejs/http'
import { node, type NodeAdapter } from '@caffeinejs/http-node'
import { afterEach, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { clientRouteOf, dist, expectNotFoundJSON, isolated, NAVIGATION, notFound, PROBE, shellOf } from './_headers.js'

const api = () => new Router('/api').get('/pets', () => ({ pets: [] })).get('/*', notFound)

const pages = () =>
  new Router()
    .detail('http', { internal: true })
    .authorize({ allowAnonymous: true })
    .get('/', shellOf(dist))
    .get('/index.html', shellOf(dist))
    .get('/*', clientRouteOf(dist))

function mounting(router: AnyRouter): HTTPPluginFactory {
  return () =>
    new (class extends HTTPPlugin {
      register({ server }: HTTPSetupContext) {
        server.mount(router)
      }
    })()
}

@Catch(ErrHTTPNotFound)
class MissHandler implements ErrorHandler<ErrHTTPNotFound> {
  handle(ctx: IContext): ActionResult {
    return ctx.status(418).body({ mine: true })
  }
}

const files = () => staticFiles(s => s.serve(dist, { unrouted: ['index.html'], anonymous: true }))

describe('a single-page application next to the plugins an application runs in production', () => {
  let app: WebApplication<never, never, unknown, NodeAdapter>

  afterEach(async () => {
    await app?.close()
  })

  it('leaves the health probes to the health plugin', async () => {
    app = isolated().with(healthProbes()).with(files()).mount(api(), pages()) as WebApplication<
      never,
      never,
      unknown,
      NodeAdapter
    >
    await app.bootstrap()

    const live = await app.request('/livez', { headers: PROBE })
    expect(live.status).toBe(200)
    expect(await live.text()).toBe('ok')
    expect(live.headers.get('cache-control')).toBe('no-store')

    expect((await app.request('/livez', { method: 'HEAD', headers: PROBE })).status).toBe(200)
    await expectNotFoundJSON(await app.request('/livez/extra', { headers: PROBE }))
  })

  // A probe is not a browser: a disabled probe path is a 404 the orchestrator can act on, not a page.
  it('does not answer a disabled probe with the shell', async () => {
    app = isolated()
      .with(healthProbes(h => h.enabled(false)))
      .with(files())
      .mount(api(), pages()) as WebApplication<never, never, unknown, NodeAdapter>
    await app.bootstrap()

    await expectNotFoundJSON(await app.request('/livez', { headers: PROBE }))
  })

  it('coexists with a CORS plugin', async () => {
    app = isolated()
      .with(corsPolicy(c => c.origins('https://app.example')))
      .with(files())
      .mount(api(), pages()) as WebApplication<never, never, unknown, NodeAdapter>
    await app.bootstrap()

    const preflight = await app.request('/api/pets', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example')

    const page = await app.request('/dashboard', { headers: NAVIGATION })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
  })

  // The client routes are ordinary routes, so a miss still reaches the application's own not-found handler.
  it("leaves a miss to the application's not-found handler", async () => {
    // Decorators on, so `@Catch` registers the handler; this module declares no controller to route.
    app = createWebApplication({ adapter: node() })
      .errorHandling(e => e.globalHandlers(MissHandler))
      .with(files())
      .mount(api(), pages()) as WebApplication<never, never, unknown, NodeAdapter>
    await app.bootstrap()

    expect((await app.request('/nope', { method: 'POST' })).status).toBe(418)

    const page = await app.request('/dashboard', { headers: NAVIGATION })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
  })

  // Installed before the static plugin on purpose: a raw route needs to declare nothing to be respected.
  it('respects a route a plugin mounted before it', async () => {
    app = isolated()
      .with(mounting(new Router().get('/metrics').handler(() => 'up 1')))
      .with(files())
      .mount(api(), pages()) as WebApplication<never, never, unknown, NodeAdapter>
    await app.bootstrap()

    const metrics = await app.request('/metrics', { headers: PROBE })
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toBe('up 1')

    // An exact URL that matched a route never reaches the client-route wildcard; a miss beside it does, and
    // a probe is not a browser.
    await expectNotFoundJSON(await app.request('/metrics/x', { headers: PROBE }))
  })
})
