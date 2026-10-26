import { request } from 'node:http'

import { newConfiguration } from '@caffeinejs/application'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { DevTool, type DevToolOperation } from '@caffeinejs/application/devtools'
import { $t } from '@caffeinejs/application/schema'
import { DevTools } from '@caffeinejs/devtools'
import { CaffeineIoC, Scopes } from '@caffeinejs/di'
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
    const res = await ui.fetch(path, init)
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

  it('draws the dependency graph with Mermaid and lists the bindings', async () => {
    const page = await html('/di')

    expect(page).toContain('<pre class="mermaid">')
    expect(page).toContain('flowchart LR')
    expect(page).toContain('src="/assets/mermaid/mermaid.min.js"')
    expect(page).toMatch(/<code>PetService<\/code>.*Repository/s)
  })

  it('keeps the graph to the bindings a filter keeps and what they are wired to', async () => {
    const page = await html('/di?q=petservice')
    const graph = /<pre class="mermaid">([\s\S]*?)<\/pre>/.exec(page)![1]

    expect(graph).toContain('PetService')
    expect(graph).toContain('Repository')
    expect(graph).not.toContain('Rates')
  })

  it('serves the Mermaid script it loads', async () => {
    const res = await ui.fetch('/assets/mermaid/mermaid.min.js')

    expect(res.status).toBe(200)
    expect((await res.text()).length).toBeGreaterThan(100_000)
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

  it('refreshes a refreshable from a form, and comes back naming it', async () => {
    const before = target.container.get(Rates).at
    const page = await html('/refreshables')
    const action = /action="(\/refreshables\/\d+\/refreshes)"/.exec(page)![1]

    const res = await ui.fetch(action, { method: 'POST' })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/refreshables?refreshed=Rates')
    expect(target.container.get(Rates).at).not.toBe(before)
  })

  it('refuses a refresh posted from another site', async () => {
    const res = await ui.fetch('/refreshables/refreshes', {
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

    const res = await ui.fetch('/')
    const page = await res.text()

    expect(res.status).toBe(502)
    expect(page).toContain('Cannot reach the devtools at http://127.0.0.1:1/devtools')
    expect(page).toContain('CAFFEINE_DEVTOOLS_TARGET__URL')

    await ui.close()
    vi.unstubAllEnvs()
  })
})
