import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'

import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
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
 * answered, and nothing the devtools mask reaches the HTML.
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

const THEME_KEY = 'caffeine-devtools:theme'
const SIDEBAR_KEY = 'caffeine-devtools:sidebar'

// jsdom ships no types, and this package is type-checked without the DOM library: the browser is driven untyped.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: object) => any }

interface Browsing {
  /** Whether the system prefers a dark theme. */
  readonly dark?: boolean
  /** What a previous page left in localStorage. */
  readonly stored?: Readonly<Record<string, string>>
  /** `false` for a browser that refuses localStorage, as a private window can. */
  readonly storage?: boolean
}

/** A page as a browser runs it, the UI's scripts inlined where the page loads them, once it has loaded. */
async function browse(page: string, browsing: Browsing = {}): Promise<any> {
  let inlined = page

  for (const name of ['site.js', 'graph.js']) {
    const source = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')
    inlined = inlined.replace(
      new RegExp(`<script src="/static/${name}"( defer)?></script>`),
      () => `<script>${source}</script>`,
    )
  }

  const { window } = new JSDOM(inlined, {
    url: 'http://127.0.0.1/',
    runScripts: 'dangerously',
    beforeParse(window: any) {
      window.matchMedia = () => ({ matches: browsing.dark === true, addEventListener() {} })

      for (const [key, value] of Object.entries(browsing.stored ?? {})) {
        window.localStorage.setItem(key, value)
      }

      if (browsing.storage === false) {
        Object.defineProperty(window, 'localStorage', {
          get: () => {
            throw new window.DOMException('The user denied storage', 'SecurityError')
          },
        })
      }
    },
  })

  await new Promise(resolve => window.addEventListener('load', resolve))
  return window
}

/** A viewBox, to the precision floating point keeps after a few zooms. */
function expectView(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(4)
  actual.forEach((value, at) => expect(value).toBeCloseTo(expected[at]!, 6))
}

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

  it('navigates to every tool the devtools list', async () => {
    const page = await html(client.get())

    for (const href of ['/info', '/health', '/di', '/config', '/routes', '/refreshables', '/events', '/runtime']) {
      expect(page).toContain(`href="${href}"`)
    }
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

  it('zooms the graph about its middle from the buttons, and resets it to the whole drawing', async () => {
    const { document } = await browse(await html(client.di.get()))
    const svg = document.querySelector('.di-graph svg')
    const level = document.querySelector('.zoom-level')
    const view = (): number[] => svg.getAttribute('viewBox').trim().split(/\s+/).map(Number)
    const press = (zoom: string): void => document.querySelector(`.graph-panel [data-zoom="${zoom}"]`).click()
    const [x, y, w, h] = view() as [number, number, number, number]

    press('in')
    // A press shows 1 / 1.25 of the width and height, centred where the view was.
    expectView(view(), [x + w * 0.1, y + h * 0.1, w * 0.8, h * 0.8])
    expect(level.textContent).toBe('125%')

    press('out')
    press('out')
    expectView(view(), [x - w * 0.125, y - h * 0.125, w * 1.25, h * 1.25])
    expect(level.textContent).toBe('80%')

    press('reset')
    expect(view()).toEqual([x, y, w, h])
    expect(level.textContent).toBe('100%')
  })

  it('switches away from the theme the system uses, and the next page opens in the one chosen', async () => {
    const page = await html(client.get())
    const first = await browse(page, { dark: true })
    const root = first.document.documentElement
    const button = first.document.querySelector('[data-action="theme"]')

    expect(root.dataset.theme).toBe(undefined)
    expect(button.getAttribute('aria-label')).toBe('Switch to the light theme')

    button.click()

    expect(root.dataset.theme).toBe('light')
    expect(button.getAttribute('aria-label')).toBe('Switch to the dark theme')
    expect(first.localStorage.getItem(THEME_KEY)).toBe('light')

    const next = await browse(page, { dark: true, stored: { [THEME_KEY]: 'light' } })

    expect(next.document.documentElement.dataset.theme).toBe('light')
  })

  it('collapses the sidebar and expands it again, and the next page opens as it was left', async () => {
    const page = await html(client.get())
    const first = await browse(page)
    const root = first.document.documentElement
    const button = first.document.querySelector('[data-action="sidebar"]')

    expect(button.getAttribute('aria-expanded')).toBe('true')

    button.click()

    expect(root.dataset.sidebar).toBe('collapsed')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.title).toBe('Expand the sidebar')
    expect(first.localStorage.getItem(SIDEBAR_KEY)).toBe('collapsed')

    const next = await browse(page, { stored: { [SIDEBAR_KEY]: 'collapsed' } })

    expect(next.document.documentElement.dataset.sidebar).toBe('collapsed')
    expect(next.document.querySelector('[data-action="sidebar"]').getAttribute('aria-expanded')).toBe('false')

    button.click()

    expect(root.dataset.sidebar).toBe(undefined)
    expect(first.localStorage.getItem(SIDEBAR_KEY)).toBe('expanded')
  })

  it('still switches the theme and the sidebar where the browser refuses storage, for that page alone', async () => {
    const { document } = await browse(await html(client.get()), { storage: false })

    document.querySelector('[data-action="theme"]').click()
    document.querySelector('[data-action="sidebar"]').click()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.sidebar).toBe('collapsed')
  })

  it('serves the script that keeps the theme and the sidebar a person chose', async () => {
    const res = await client.$fetch('/static/site.js')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it('marks every page with the CaffeineJS icon, and serves it', async () => {
    const page = await html(client.get())

    expect(page).toContain('<link rel="icon" href="/static/brand/logo.svg" type="image/svg+xml"')
    expect(page).toMatch(/<a class="brand" href="\/">\s*<img class="brand-mark" src="\/static\/brand\/logo.svg"/)

    for (const [path, type] of [
      ['/static/brand/logo.svg', 'image/svg+xml'],
      ['/static/brand/favicon-32.png', 'image/png'],
      ['/static/brand/apple-touch-icon.png', 'image/png'],
    ] as const) {
      const res = await client.$fetch(path)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
    }
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

  it('answers its probes, so an orchestrator keeps it running while the devtools it reads are down', async () => {
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', 'http://127.0.0.1:1/devtools')
    vi.stubEnv('CAFFEINE_DEVTOOLS_SERVER__PORT', '0')
    const ui = buildApp({ logger: false })
    const { address } = await ui.run()

    try {
      for (const probe of ['/livez', '/readyz', '/startupz']) {
        expect((await fetch(new URL(probe, address.origin))).status, probe).toBe(200)
      }
    } finally {
      await ui.close()
      vi.unstubAllEnvs()
    }
  })

  // Behind a container's published port a request arrives on the container's own address, not on loopback, so the
  // name it carries is all there is to tell a DNS-rebinding page from a person.
  it("refuses another site's name whatever address the request came in on", async () => {
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', 'http://127.0.0.1:1/devtools')
    const ui = buildApp({ logger: false })
    await ui.bootstrap()

    try {
      const status = async (host: string, path = '/'): Promise<number> =>
        (await ui.request(path, { headers: { host } })).status

      expect(await status('evil.example:9091')).toBe(421)
      expect(await status('localhost:9091')).toBe(502)
      expect(await status('127.0.0.1:9091')).toBe(502)
      expect(await status('[::1]:9091')).toBe(502)
      // A kubelet probes the pod's address.
      expect(await status('10.1.2.3:9091', '/livez')).toBe(200)
    } finally {
      await ui.close()
      vi.unstubAllEnvs()
    }
  })

  it('answers the names CAFFEINE_DEVTOOLS_ALLOWED_HOSTS lists, as a proxy in front of it forwards them', async () => {
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', 'http://127.0.0.1:1/devtools')
    vi.stubEnv('CAFFEINE_DEVTOOLS_ALLOWED_HOSTS', 'devtools.internal,Ops.Example')
    const ui = buildApp({ logger: false })
    await ui.bootstrap()

    try {
      const status = async (host: string): Promise<number> => (await ui.request('/', { headers: { host } })).status

      expect(await status('devtools.internal')).toBe(502)
      expect(await status('ops.example:443')).toBe(502)
      expect(await status('evil.example')).toBe(421)
    } finally {
      await ui.close()
      vi.unstubAllEnvs()
    }
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
