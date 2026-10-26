import { request } from 'node:http'

import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { DevTool, type DevToolOperation } from '@caffeinejs/application/devtools'
import { $t } from '@caffeinejs/application/schema'
import { DevTools } from '@caffeinejs/devtools'
import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import type { WebApplication } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
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

const listener = { host: '127.0.0.1', port: 0 }

describe('devtools UI', () => {
  let target: WebApplication
  let ui: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const conf = newConfiguration($t.Object({ db: $t.Object({ pass: $t.Secret($t.String()), pool: $t.Integer() }) }))
      .source(new InlineConfigSource({ db: { pass: 'hunter2', pool: 4 } }))
      .build().config

    target = createWebApplication({ container: new CaffeineIoC({ decorators: false }), config: conf, logger: false })
      .server(() => ({ listener }))
      .install(DevTools(d => d.port(0).showConfigValues())) as WebApplication
    target.container.bind(Repository, t => t.toSelf())
    target.container.bind(PetService, t => t.toSelf([Repository]))
    target.container.bind(Rates, t => t.toSelf().lifetime(Scopes.REFRESH))
    target.container.bind(QueueTool, t => t.toSelf().extends(DevTool))
    // A key that reads as DOT: the graph must draw it as a label, not as a node attribute.
    target.container.bind(token<string>('x" URL="javascript:alert(1)'), t => t.toValue('crafted'))
    await target.run()

    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', `${target.listeners.get('devtools')!.address!.origin}/devtools`)
    vi.stubEnv('CAFFEINE_DEVTOOLS_SERVER__PORT', '0')
    ui = buildApp({ logger: false })
    await ui.run()
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await ui?.close()
    await target?.close()
  })

  async function html(path: string, init?: RequestInit): Promise<string> {
    const res = await ui.request(path, init)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    return res.text()
  }

  it('navigates to every tool the devtools list, a contributed one included', async () => {
    const page = await html('/')

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
    const page = await html('/di')
    const graph = graphOf(page)
    // A node is a `<g class="node">` titled with its name, its first line of text the binding's key.
    const nodes = [...graph.matchAll(/<g id="node\d+" class="node">\s*<title>(n\d+)<\/title>([\s\S]*?)<\/g>/g)]
    const id = (key: string): string => nodes.find(([, , body]) => body!.includes(`>${key}<`))![1]!

    expect(graph).toContain(`<title>${id('PetService')}&#45;&gt;${id('Repository')}</title>`)
    expect(page).toContain('src="/static/graph.js"')
    expect(page).toMatch(/<code>PetService<\/code>.*Repository/s)
  })

  it('keeps the graph to the bindings a filter keeps and what they are wired to', async () => {
    const graph = graphOf(await html('/di?q=petservice'))

    expect(graph).toContain('PetService')
    expect(graph).toContain('Repository')
    expect(graph).not.toContain('Rates')
  })

  it('draws a binding whose key is written as DOT as text, never as a link', async () => {
    const graph = graphOf(await html('/di'))

    expect(graph).toContain('x&quot; URL=&quot;javascript:alert(1)')
    expect(graph).not.toMatch(/xlink:href|<a /)
  })

  it('serves the script that makes the graph explorable', async () => {
    const res = await ui.request('/static/graph.js')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain("querySelectorAll('.di-graph')")
  })

  it('shows configuration values masked as the devtools masked them', async () => {
    const page = await html('/config')

    expect(page).toContain('db.pass')
    expect(page).toContain('******')
    expect(page).not.toContain('hunter2')
  })

  it("lists every server's routes with what each requires", async () => {
    const page = await html('/routes')

    expect(page).toContain('The application&#39;s own server')
    expect(page).toContain('Listener devtools')
    expect(page).toContain('/devtools/routes')
  })

  it("filters the routes to one server, the application's own being the empty name, or back to every server", async () => {
    const page = await html('/routes')
    const every = /<option value="([^"]*)"[^>]*>every server<\/option>/.exec(page)?.[1]

    const all = await html(`/routes?server=${every}`)
    const own = await html('/routes?server=')

    expect(all).toContain('The application&#39;s own server')
    expect(all).toContain('Listener devtools')
    expect(own).toContain('The application&#39;s own server')
    expect(own).not.toContain('Listener devtools')
  })

  it('refreshes a refreshable from a form, and comes back naming it', async () => {
    const before = target.container.get(Rates).at
    const page = await html('/refreshables')
    const action = /action="(\/refreshables\/\d+\/refreshes)"/.exec(page)![1]

    const res = await ui.request(action, { method: 'POST' })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/refreshables?refreshed=Rates')
    expect(target.container.get(Rates).at).not.toBe(before)
  })

  it('refuses a refresh posted from another site', async () => {
    const res = await ui.request('/refreshables/refreshes', {
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
    const page = await html('/contributions/queue')

    expect(page).toMatch(/pending&#?\w+;: 3/)
    expect(page).toContain('w-&lt;script>')
    expect(page).not.toContain('w-<script>')
    expect(page).toContain('/devtools/queue/jobs/:id')
  })

  it.each([
    ['/info', process.version],
    ['/health', 'readiness'],
    ['/events', 'binding-initialized'],
    ['/runtime', 'heapUsed'],
  ])('renders %s with what the devtools answered', async (path, shown) => {
    expect(await html(path)).toContain(shown)
  })
})

describe('devtools UI without devtools to read', () => {
  it('says which URL it could not reach and the variable that changes it', async () => {
    vi.stubEnv('CAFFEINE_DEVTOOLS_TARGET__URL', 'http://127.0.0.1:1/devtools')
    const ui = buildApp({ logger: false })
    await ui.bootstrap()

    const res = await ui.request('/')
    const page = await res.text()

    expect(res.status).toBe(502)
    expect(page).toContain('Cannot reach the devtools at http://127.0.0.1:1/devtools')
    expect(page).toContain('CAFFEINE_DEVTOOLS_TARGET__URL')

    await ui.close()
    vi.unstubAllEnvs()
  })
})
