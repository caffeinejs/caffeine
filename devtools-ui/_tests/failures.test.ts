import { info } from '@caffeinejs/devtools'
import { RouteBuilder, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { PROTECTED, closedPort, page, startTarget, startUI, upstream, type Target, type Upstream } from './fixtures.js'

describe('the UI when an application fails it', () => {
  const opened: WebApplication[] = []
  const upstreams: Upstream[] = []

  afterEach(async () => {
    await Promise.all([
      ...opened.splice(0).map(app => app.close()),
      ...upstreams.splice(0).map(server => server.close()),
    ])
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

  // The UI is the gateway: an application it cannot read is a failure upstream, never a crash of its own.
  it('tells an application it cannot reach, with the system error', async () => {
    const view = await ui({ orders: { url: `http://127.0.0.1:${await closedPort()}/devtools` } })

    const home = await page(view, '/')

    expect(home.status).toBe(200)
    expect(home.text).toContain('Cannot reach the application')
    expect(home.text).toContain('ECONNREFUSED')

    const overview = await page(view, '/orders/info')

    expect(overview.status).toBe(502)
    expect(overview.text).toContain('ECONNREFUSED')
    expect(overview.text).toContain('"applications.orders.url"')
  })

  it('tells credentials that are refused from credentials that fall short', async () => {
    const orders = await target({ basic: true, devtools: d => d.authorize(PROTECTED) })
    const view = await ui({
      wrong: { url: orders.url, auth: { basic: { username: 'ops', password: 'wrong' } } },
      viewer: { url: orders.url, auth: { basic: { username: 'viewer', password: 'secret' } } },
      ops: { url: orders.url, auth: { basic: { username: 'ops', password: 'secret' } } },
    })

    const home = await page(view, '/')

    expect(home.text).toContain('Not authenticated (401)')
    expect(home.text).toContain('Not authorized (403)')
    expect(home.text.match(/>up</g)).toHaveLength(1)

    const refused = await page(view, '/wrong')

    expect(refused.status).toBe(502)
    expect(refused.text).toContain('"applications.wrong.auth"')
    expect((await page(view, '/ops/info')).status).toBe(200)
  })

  it('answers 504 for an application that does not answer in time', async () => {
    const orders = await target({
      devtools: d =>
        d.slices(info(), {
          id: 'slow',
          routes: () => [
            new RouteBuilder()
              .method('GET')
              .path('/')
              .handle(() => new Promise(resolve => setTimeout(() => resolve({ late: true }), 1000))),
          ],
        }),
    })
    const view = await ui({ orders: { url: orders.url, timeout: '200ms' } })

    const slow = await page(view, '/orders/slow')

    expect(slow.status).toBe(504)
    expect(slow.text).toContain('Timed out')
    expect(slow.text).toContain('"applications.orders.timeout"')
  })

  it('refuses an answer that is not DevTools', async () => {
    const html = await upstream('<html>a login page</html>', 'text/html')
    const notIndex = await upstream('{"hello":"world"}')
    upstreams.push(html, notIndex)

    const view = await ui({ html: { url: html.url }, json: { url: notIndex.url } })

    const home = await page(view, '/')

    expect(home.text.match(/Not a DevTools answer/g)).toHaveLength(2)
    expect((await page(view, '/html')).status).toBe(502)
    expect((await page(view, '/json')).status).toBe(502)
  })

  // An unknown application or slice costs the application nothing beyond its index.
  it('answers 404 for an unknown application or an unlisted slice, calling no more than the index', async () => {
    const server = await upstream('{"slices":[{"id":"info","href":"/devtools/info"}]}')
    upstreams.push(server)

    const view = await ui({ orders: { url: server.url } })

    expect((await page(view, '/payments')).status).toBe(404)
    expect(server.requests).toHaveLength(0)

    expect((await page(view, '/orders/bindings')).status).toBe(404)
    expect((await page(view, '/orders/secrets')).status).toBe(404)
    expect(server.requests.map(request => request.path)).toEqual(['/devtools', '/devtools'])
  })
})
