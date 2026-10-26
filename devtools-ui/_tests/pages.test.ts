import { request } from 'node:http'

import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { DevTool, type DevToolOperation } from '@caffeinejs/application/devtools'
import { down, HealthIndicator, type HealthReport } from '@caffeinejs/application/health'
import { $t } from '@caffeinejs/application/schema'
import { DevTools } from '@caffeinejs/devtools'
import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  Identity,
  Principal,
  type IContext,
  type WebApplication,
} from '@caffeinejs/http'
import { authentication, createWebApplication, csrf, healthProbes, newRouter } from '@caffeinejs/http/fastify'
import { testClient, type TestClient } from '@caffeinejs/testing/http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../app.js'

/**
 * The UI against a running application's devtools, over a real socket: every page renders what the devtools
 * answered, a contributed tool gets a page of its own, and nothing the devtools mask reaches the HTML.
 */

class Repository {
  find(): string {
    return 'pet'
  }
}

class PetService {
  constructor(readonly repository: Repository) {}
}

class Rates {
  readonly at = Math.random()
}

class QueueTool extends DevTool {
  readonly id = 'queue'
  readonly title = 'Job queue'
  readonly description = 'Pending jobs'
  readonly operations: DevToolOperation[] = [
    { method: 'GET', path: '', handle: () => ({ pending: 3 }) },
    { method: 'GET', path: '/workers', handle: () => [{ name: 'w-<script>' }] },
    { method: 'GET', path: '/jobs/:id', handle: () => ({}) },
  ]
}

class Mailer extends HealthIndicator {
  get name(): string {
    return 'mailer'
  }

  override get critical(): boolean {
    return false
  }

  async check(): Promise<HealthReport> {
    return down('smtp unreachable')
  }
}

const listener = { host: '127.0.0.1', port: 0 }

describe('devtools UI', () => {
  let target: WebApplication
  let ui: ReturnType<typeof buildApp>
  // Typed by the UI's own routes: a page renamed or removed breaks this file.
  let client: TestClient<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    const conf = newConfiguration($t.Object({ db: $t.Object({ pass: $t.Secret($t.String()), pool: $t.Integer() }) }))
      .source(new InlineConfigSource({ db: { pass: 'hunter2', pool: 4 } }))
      .build().config

    target = createWebApplication({ container: new CaffeineIoC({ decorators: false }), config: conf, logger: false })
      .server(() => ({ listener }))
      .install(DevTools(d => d.port(0).showConfigValues())) as WebApplication
    target.container.bind(Repository, t => t.toSelf())
    target.container.bind(PetService, t => t.toSelf([Repository]))
    target.container.bind(Rates, t => t.toSelf().lifetime(Scopes.REFRESH).labels(Symbol('rates')))
    target.container.bind(Mailer, t => t.toSelf().extends(HealthIndicator))
    target.container.bind(QueueTool, t => t.toSelf().extends(DevTool))
    // A key that reads as DOT: the graph must draw it as a label, not as a node attribute.
    target.container.bind(token<string>('x" URL="javascript:alert(1)'), t => t.toValue('crafted'))
    await target.run()

    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', `${target.listeners.get('devtools')!.address!.origin}/devtools`)
    vi.stubEnv('CAFFEINE_DEVTOOLS_SERVER__PORT', '0')
    ui = buildApp({ logger: false })
    // Listening, for the test that reaches the UI on its socket; the others go through the client.
    await ui.run()
    client = testClient(ui)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await ui?.close()
    await target?.close()
  })

  async function html(sent: Promise<{ readonly headers: Headers; text(): Promise<string> }>): Promise<string> {
    const res = await sent
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    return res.text()
  }

  it('navigates to every tool the devtools list, a contributed one included', async () => {
    const page = await html(client.get())

    for (const href of ['/info', '/health', '/di', '/config', '/routes', '/refreshables', '/events', '/runtime']) {
      expect(page).toContain(`href="${href}"`)
    }
    expect(page).toContain('href="/contributions/queue"')
  })

  /** The SVG Graphviz drew on the page, or `''` when there is none. */
  function graphOf(page: string): string {
    return /<div class="di-graph">\s*(<svg[\s\S]*?<\/svg>)\s*<\/div>/.exec(page)?.[1] ?? ''
  }

  it('draws the dependency graph on the server, with the edge from a binding to what it injects', async () => {
    const page = await html(client.di.get())
    const graph = graphOf(page)
    // A node is a `<g class="node">` titled with its name, its first line of text the binding's key.
    const nodes = [...graph.matchAll(/<g id="node\d+" class="node">\s*<title>(n\d+)<\/title>([\s\S]*?)<\/g>/g)]
    const id = (key: string): string => nodes.find(([, , body]) => body!.includes(`>${key}<`))![1]!

    expect(graph).toContain(`<title>${id('PetService')}&#45;&gt;${id('Repository')}</title>`)
    expect(page).toContain('src="/static/graph.js"')
    expect(page).toMatch(/<code>PetService<\/code>.*Repository/s)
  })

  it('keeps the graph to the bindings a filter keeps and what they are wired to', async () => {
    const graph = graphOf(await html(client.di.get({ query: { q: 'petservice' } })))

    expect(graph).toContain('PetService')
    expect(graph).toContain('Repository')
    expect(graph).not.toContain('Rates')
  })

  it('draws a binding whose key is written as DOT as text, never as a link', async () => {
    const graph = graphOf(await html(client.di.get()))

    expect(graph).toContain('x&quot; URL=&quot;javascript:alert(1)')
    expect(graph).not.toMatch(/xlink:href|<a /)
  })

  it('serves the script that makes the graph explorable', async () => {
    const res = await client.$fetch('/static/graph.js')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain("querySelectorAll('.di-graph')")
  })

  it('shows configuration values masked as the devtools masked them', async () => {
    const page = await html(client.config.get())

    expect(page).toContain('db.pass')
    expect(page).toContain('******')
    expect(page).not.toContain('hunter2')
  })

  it("lists every server's routes with what each requires", async () => {
    const page = await html(client.routes.get())

    expect(page).toContain('The application&#39;s own server')
    expect(page).toContain('Listener devtools')
    expect(page).toContain('/devtools/routes')
  })

  it("filters the routes to one server, the application's own being the empty name, or back to every server", async () => {
    const page = await html(client.routes.get())
    const every = /<option value="([^"]*)"[^>]*>every server<\/option>/.exec(page)?.[1]

    const all = await html(client.routes.get({ query: { server: every! } }))
    const own = await html(client.routes.get({ query: { server: '' } }))

    expect(all).toContain('The application&#39;s own server')
    expect(all).toContain('Listener devtools')
    expect(own).toContain('The application&#39;s own server')
    expect(own).not.toContain('Listener devtools')
  })

  it('refreshes a refreshable from a form, and comes back naming it', async () => {
    const before = target.container.get(Rates).at
    const page = await html(client.refreshables.get())
    const id = /action="\/refreshables\/(\d+)\/refreshes"/.exec(page)![1]!

    const res = await client.refreshables({ id }).refreshes.post()

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/refreshables?refreshed=Rates')
    expect(target.container.get(Rates).at).not.toBe(before)
  })

  it('refreshes by label from the form, and comes back naming what it refreshed', async () => {
    const before = target.container.get(Rates).at
    expect(await html(client.refreshables.get())).toContain('<option value="rates">')

    // Posted as the browser posts the form.
    const res = await client.$fetch('/refreshables/refreshes', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'label=rates',
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/refreshables?refreshed=Rates')
    expect(target.container.get(Rates).at).not.toBe(before)
  })

  it('opens one value with every layer that set it, masked as the devtools masked it', async () => {
    const page = await html(client.config({ path: 'db.pass' }).get())

    expect(page).toMatch(/<td>inline<\/td>\s*<td>inline<\/td>/)
    expect(page).toContain('******')
    expect(page).not.toContain('hunter2')
  })

  it('answers 404 for a tool the devtools do not serve', async () => {
    const res = await client.contributions({ id: 'nope' }).get()

    expect(res.status).toBe(404)
    expect(await res.text()).toContain('The devtools serve no tool &#34;nope&#34;')
  })

  it('draws no graph for a filter that keeps no binding', async () => {
    expect(await html(client.di.get({ query: { q: 'no-such-binding' } }))).toContain('No bindings to draw.')
  })

  it('shows a failing indicator that does not fail the probe for what it is', async () => {
    const page = await html(client.health.get())

    expect(page).toContain('mailer (not critical)')
    expect(page).toContain('smtp unreachable')
  })

  it('refuses a refresh posted from another site', async () => {
    // Sent as a form would be, which the typed client never does.
    const res = await client.$fetch('/refreshables/refreshes', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'label=',
    })

    expect(res.status).toBe(403)
  })

  it("refuses a request under another site's name, which DNS rebinding would send to its loopback port", async () => {
    const { port } = new URL(ui.address!.origin)
    const status = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        request({ host: '127.0.0.1', port: Number(port), path: '/', headers: { host } }, res => {
          res.resume()
          resolve(res.statusCode!)
        })
          .on('error', reject)
          .end()
      })

    expect(await status(`evil.example:${port}`)).toBe(421)
    expect(await status(`127.0.0.1:${port}`)).toBe(200)
  })

  it("renders a contributed tool's resources, escaping what it answers", async () => {
    const page = await html(client.contributions({ id: 'queue' }).get())

    expect(page).toMatch(/pending&#?\w+;: 3/)
    expect(page).toContain('w-&lt;script>')
    expect(page).not.toContain('w-<script>')
    expect(page).toContain('/devtools/queue/jobs/:id')
  })

  it.each<[string, () => Promise<Response>, string]>([
    ['/info', () => client.info.get(), process.version],
    ['/health', () => client.health.get(), 'readiness'],
    ['/events', () => client.events.get(), 'binding-initialized'],
    ['/runtime', () => client.runtime.get(), 'heapUsed'],
  ])('renders %s with what the devtools answered', async (_, open, shown) => {
    expect(await html(open())).toContain(shown)
  })
})

describe('devtools UI without devtools to read', () => {
  it('says which URL it could not reach and the variable that changes it', async () => {
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', 'http://127.0.0.1:1/devtools')
    await using ui = testClient(buildApp({ logger: false }))

    const res = await ui.get()
    const page = await res.text()

    expect(res.status).toBe(502)
    expect(page).toContain('Cannot reach the devtools at http://127.0.0.1:1/devtools')
    expect(page).toContain('CAFFEINE_DEVTOOLS_TARGET__URL')
    vi.unstubAllEnvs()
  })
})

/** Authenticates `Bearer <user>:<role>` as that user, holding that role. */
class BearerScheme extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    const [user, role = ''] = (ctx.req.header('authorization') ?? '').replace(/^Bearer /, '').split(':')

    return user === undefined || user === ''
      ? AuthenticateResult.none()
      : AuthenticateResult.success(
          new AuthenticationTicket(
            new Principal(true, [
              new Identity('Bearer', true, [new Claim('sub', user, ''), new Claim('roles', role, '')]),
            ]),
            'Bearer',
          ),
        )
  }
}

describe('devtools UI over devtools that require credentials', () => {
  let target: WebApplication

  beforeAll(async () => {
    target = createWebApplication({ logger: false })
      .server(() => ({ listener }))
      .install(Authentication(a => a.addStrategy('Bearer', new BearerScheme())))
      .install(DevTools(d => d.port(0).authorize({ roles: ['ops'] })))
      .with(authentication())
      .with(csrf())
      // Raw routes, exempt from authentication.
      .with(healthProbes(h => h.enabled(true)))
      .mount(
        newRouter('/pets')
          .authorize({ roles: ['keeper'] })
          .get('/', () => [])
          .post('/', () => ({})),
      ) as WebApplication
    await target.run()
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await target?.close()
  })

  function ui(authorization?: string, path = '/devtools') {
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', `${target.listeners.get('devtools')!.address!.origin}${path}`)
    if (authorization === undefined) {
      vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION', undefined)
    } else {
      vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION', authorization)
    }

    return testClient(buildApp({ logger: false }))
  }

  it('names the variable that sends credentials when the devtools refuse the UI', async () => {
    await using client = ui()

    const res = await client.get()
    const page = await res.text()

    expect(res.status).toBe(502)
    expect(page).toContain('The devtools answered 401')
    expect(page).toContain('CAFFEINE_DEVTOOLS_TARGET__AUTHORIZATION')
  })

  it('sends the credentials it is given, and shows what protects each route', async () => {
    await using client = ui('Bearer ann:ops')

    const res = await client.routes.get({ query: { server: '' } })
    const page = await res.text()

    expect(res.status).toBe(200)
    expect(page).toContain('role keeper')
    expect(page).toMatch(/<code>\/livez<\/code> <span class="badge badge-muted">raw<\/span>/)
    expect(page).toContain('exempt')
    expect(page).toContain('default: Bearer')
    expect(page).toMatch(/protected/)
    expect(page).toContain('Schemes: Bearer')
  })

  it('names the path to check when the devtools are not where it looks', async () => {
    await using client = ui('Bearer ann:ops', '/nowhere')

    const res = await client.get()
    const page = await res.text()

    expect(res.status).toBe(404)
    expect(page).toContain('The devtools answered 404')
    expect(page).toContain('names the devtools path')
  })
})
