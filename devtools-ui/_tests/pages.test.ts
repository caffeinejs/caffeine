import { bindings, configuration, graph, health, info, routes, type DevToolsBindingsReport } from '@caffeinejs/devtools'
import { CaffeineIoC } from '@caffeinejs/di'
import { Ops, RouteBuilder, bindTo, newRouter, type WebApplication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { HealthIndicator, down, type HealthReport } from '@caffeinejs/std/health'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { page, startTarget, startUI, type Target } from './fixtures.js'

class Repo {
  readonly kind = 'repo'
}

class Service {
  constructor(readonly repo: Repo) {}
}

class Database extends HealthIndicator {
  get name(): string {
    return 'database'
  }

  check(): HealthReport {
    return down('connection refused')
  }
}

function container(): CaffeineIoC {
  const container = new CaffeineIoC({ decorators: false })
  container.bind(Repo, t => t.toClass(Repo))
  container.bind(Service, t => t.toClass(Service, [Repo]))
  container.bind(Database, t => t.toClass(Database).extends(HealthIndicator))
  return container
}

describe('the UI pages', () => {
  const opened: WebApplication[] = []

  afterEach(async () => {
    await Promise.all(opened.splice(0).map(app => app.close()))
  })

  async function target(options: Parameters<typeof startTarget>[0] = {}): Promise<Target> {
    const started = await startTarget(options)
    opened.push(started.app)
    return started
  }

  async function ui(applications: Record<string, unknown>): Promise<WebApplication> {
    const started = await startUI(applications)
    opened.push(started)
    return started
  }

  // The configured URL is the DevTools index, wherever it is mounted: under a path or at a server's root.
  it('lists every configured application, in order, with what each serves', async () => {
    const orders = await target()
    const root = await target({ path: '/', devtools: d => d.slices(info()) })

    const home = await page(await ui({ orders: { url: orders.url }, root: { url: root.url } }), '/')

    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toMatch(/^text\/html/)
    expect(home.html.indexOf('href="/orders"')).toBeLessThan(home.html.indexOf('href="/root"'))
    expect(home.html).toContain('bindings, graph, routes, health, info, configuration')
    expect(home.html.match(/>up</g)).toHaveLength(2)
  })

  it('offers exactly the slices the index lists', async () => {
    const orders = await target({ devtools: d => d.slices(info(), health()) })
    const view = await ui({ orders: { url: orders.url } })

    const overview = await page(view, '/orders')

    expect(overview.status).toBe(200)
    expect(overview.html).toContain('href="/orders/info"')
    expect(overview.html).toContain('href="/orders/health"')
    expect(overview.html).not.toContain('href="/orders/bindings"')

    expect((await page(view, '/orders/bindings')).status).toBe(404)
  })

  it('lists bindings, hiding internal ones unless asked, and filters them', async () => {
    const orders = await target({ container: container() })
    const view = await ui({ orders: { url: orders.url } })

    const all = await page(view, '/orders/bindings')

    expect(all.status).toBe(200)
    expect(all.html).toContain('<code>Repo</code>')
    expect(all.html).toContain('<code>Service</code>')
    expect(all.html).not.toContain('<code>ApplicationHealth</code>')

    expect((await page(view, '/orders/bindings?internal=on')).html).toContain('<code>ApplicationHealth</code>')

    const filtered = await page(view, '/orders/bindings?q=rep')

    expect(filtered.html).toContain('<code>Repo</code>')
    expect(filtered.html).not.toContain('<code>Service</code>')
  })

  it('shows a binding with what it depends on and what depends on it', async () => {
    const orders = await target({ container: container() })
    const view = await ui({ orders: { url: orders.url } })

    const { bindings: reported } = (await (await fetch(`${orders.url}/bindings`)).json()) as DevToolsBindingsReport
    const repo = reported.find(binding => binding.key === 'Repo')!
    const service = reported.find(binding => binding.key === 'Service')!

    const servicePage = await page(view, `/orders/bindings/${service.id}`)
    const dependsOn = servicePage.html.slice(
      servicePage.html.indexOf('Depends on'),
      servicePage.html.indexOf('Used by'),
    )

    expect(servicePage.status).toBe(200)
    expect(dependsOn).toContain(`href="/orders/bindings/${repo.id}"`)

    const repoPage = await page(view, `/orders/bindings/${repo.id}`)

    expect(repoPage.html.slice(repoPage.html.indexOf('Used by'))).toContain(`href="/orders/bindings/${service.id}"`)

    expect((await page(view, '/orders/bindings/999999')).status).toBe(404)
    expect((await page(view, '/orders/bindings/repo')).status).toBe(404)
  })

  it('draws the graph as adjacency lists and Mermaid source, internal bindings hidden', async () => {
    const orders = await target({ container: container() })
    const view = await ui({ orders: { url: orders.url } })

    const graphPage = await page(view, '/orders/graph')

    expect(graphPage.status).toBe(200)
    expect(graphPage.html).toContain('flowchart LR')
    expect(graphPage.html).toMatch(
      /<code>Service<\/code><\/a><ul><li><a href="\/orders\/bindings\/\d+"><code>Repo<\/code>/,
    )
    expect(graphPage.html).not.toContain('<code>ApplicationHealth</code>')
    expect((await page(view, '/orders/graph?internal=on')).html).toContain('<code>ApplicationHealth</code>')
  })

  it('shows the routes of every server, each under its own', async () => {
    const orders = await target({
      configure: app => {
        app.install(Ops('admin', o => o.server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))))
        app.mount(
          newRouter('/pets').get('/', () => []),
          newRouter('/jobs')
            .with(bindTo('admin'))
            .get('/', () => []),
        )
      },
    })

    const routesPage = await page(await ui({ orders: { url: orders.url } }), '/orders/routes')
    const own = routesPage.text.indexOf("<h2>The application's server</h2>")
    const admin = routesPage.text.indexOf('<h2>Ops server "admin"</h2>')

    expect(routesPage.status).toBe(200)
    expect(own).toBeGreaterThan(-1)
    expect(admin).toBeGreaterThan(own)
    expect(routesPage.text.indexOf('<code>/pets</code>')).toBeGreaterThan(own)
    expect(routesPage.text.indexOf('<code>/pets</code>')).toBeLessThan(admin)
    expect(routesPage.text.indexOf('<code>/jobs</code>')).toBeGreaterThan(admin)
  })

  it('shows health with each indicator, and the process', async () => {
    const orders = await target({ container: container(), name: 'orders-api' })
    const view = await ui({ orders: { url: orders.url } })

    const healthPage = await page(view, '/orders/health')

    expect(healthPage.status).toBe(200)
    expect(healthPage.html).toContain('database')
    expect(healthPage.html).toContain('connection refused')
    expect(healthPage.html).toMatch(/Readiness<\/span> <span class="badge bad">failing/)

    const infoPage = await page(view, '/orders/info')

    expect(infoPage.html).toContain('orders-api')
    expect(infoPage.html).toContain(process.version)
  })

  it('shows configuration values only as the application sends them', async () => {
    const config = () =>
      newConfiguration($t.Object({ db: $t.Object({ host: $t.String(), password: $t.String() }) }))
        .source(new InlineConfigSource({ db: { host: 'db.internal', password: 'hunter2' } }))
        .build().config

    const hidden = await target({ config: config(), devtools: d => d.slices(configuration()) })
    const shown = await target({ config: config(), devtools: d => d.slices(configuration(c => c.showValues())) })
    const view = await ui({ hidden: { url: hidden.url }, shown: { url: shown.url } })

    const withheld = await page(view, '/hidden/configuration')

    expect(withheld.status).toBe(200)
    expect(withheld.text).toMatch(
      /<code>db\.host<\/code><\/td><td><span class="muted">hidden<\/span><\/td><td>inline<\/td>/,
    )
    expect(withheld.text).not.toContain('db.internal')

    const sent = await page(view, '/shown/configuration')

    expect(sent.text).toContain('<code>"db.internal"</code>')
    expect(sent.text).toMatch(/<code>db\.password<\/code><\/td><td><span class="badge warn">masked<\/span>/)
    expect(sent.text).not.toContain('hunter2')
  })

  // A slice the UI has no page for still shows, so a new core slice needs no change here.
  it('shows a slice it has no page for as the JSON it answered with', async () => {
    const orders = await target({
      devtools: d =>
        d.slices(info(), {
          id: 'jobs',
          routes: () => [
            new RouteBuilder()
              .method('GET')
              .path('/')
              .handle(() => ({ pending: 3, queues: ['mail'] })),
          ],
        }),
    })

    const jobs = await page(await ui({ orders: { url: orders.url } }), '/orders/jobs')

    expect(jobs.status).toBe(200)
    expect(jobs.text).toContain(`<pre>${JSON.stringify({ pending: 3, queues: ['mail'] }, null, 2)}</pre>`)
  })

  it('answers 404 for an application nobody configured', async () => {
    const orders = await target({ devtools: d => d.slices(bindings(), graph(), routes()) })

    expect((await page(await ui({ orders: { url: orders.url } }), '/payments')).status).toBe(404)
  })
})
