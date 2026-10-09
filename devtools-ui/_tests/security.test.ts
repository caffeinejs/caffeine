import { bindings, info, routes } from '@caffeinejs/devtools'
import { CaffeineIoC, token } from '@caffeinejs/di'
import { RouteBuilder, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { page, startTarget, startUI, upstream, type Upstream } from './fixtures.js'

const PAYLOAD = '<script>alert(1)</script>'

describe('the UI and what an application sends it', () => {
  const opened: WebApplication[] = []
  const upstreams: Upstream[] = []

  afterEach(async () => {
    await Promise.all([
      ...opened.splice(0).map(app => app.close()),
      ...upstreams.splice(0).map(server => server.close()),
    ])
  })

  // Whatever an application reports is text: a key, a name or a value that looks like markup must not become markup
  // in a page an operator opens.
  it('renders what an application sends as text, never as markup', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(token<number>(PAYLOAD), t => t.toValue(1))

    const target = await startTarget({
      container,
      name: PAYLOAD,
      devtools: d =>
        d.slices(bindings(), routes(), info(), {
          id: 'evil',
          routes: () => [
            new RouteBuilder()
              .method('GET')
              .path('/')
              .handle(() => ({ note: PAYLOAD })),
          ],
        }),
      configure: app => {
        app.mount(
          newRouter('/x')
            .name(PAYLOAD)
            .get('/', () => ({})),
        )
      },
    })
    opened.push(target.app)

    const view = await startUI({ orders: { url: target.url } })
    opened.push(view)

    for (const path of ['/orders', '/orders/info', '/orders/bindings?internal=on', '/orders/routes', '/orders/evil']) {
      const shown = await page(view, path)

      expect(shown.status, path).toBe(200)
      expect(shown.html, path).not.toContain(PAYLOAD)
      expect(shown.text, path).toContain(PAYLOAD)
    }
  })

  // The index is the one place a link target comes from: an id it lists is a path segment, and its hrefs are ignored.
  it('builds links from what an index lists without following them', async () => {
    const server = await upstream(
      JSON.stringify({ slices: [{ id: `"><img src=x onerror=alert(1)>`, href: 'javascript:alert(1)' }] }),
    )
    upstreams.push(server)

    const view = await startUI({ orders: { url: server.url } })
    opened.push(view)

    const overview = await page(view, '/orders')

    expect(overview.status).toBe(200)
    expect(overview.html).not.toContain('<img')
    expect(overview.html).not.toContain('javascript:')
    expect(overview.html).toContain(`href="/orders/${encodeURIComponent('"><img src=x onerror=alert(1)>')}"`)
  })

  it('sets its response headers on every page, a failure and a missing one included', async () => {
    const server = await upstream('not json')
    upstreams.push(server)

    const view = await startUI({ orders: { url: server.url } })
    opened.push(view)

    for (const path of ['/', '/orders', '/missing']) {
      const { headers } = await page(view, path)

      expect(headers.get('content-security-policy'), path).toBe(
        "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      expect(headers.get('x-content-type-options'), path).toBe('nosniff')
      expect(headers.get('referrer-policy'), path).toBe('no-referrer')
      expect(headers.get('cache-control'), path).toBe('no-store')
    }
  })

  // A page loads nothing but its stylesheet, which a browser may keep for good: its name changes with its content.
  it('serves the stylesheet each page links, for good', async () => {
    const server = await upstream('{"slices":[]}')
    upstreams.push(server)

    const view = await startUI({ orders: { url: server.url } })
    opened.push(view)

    const home = await page(view, '/')
    const [link] = home.html.match(/<link rel="stylesheet" href="(\/_ui\/style\.[a-f0-9]{10}\.css)"\/>/) ?? []
    const stylesheet = await view.fetch(/href="([^"]+)"/.exec(link!)![1]!)

    expect(stylesheet.status).toBe(200)
    expect(stylesheet.headers.get('content-type')).toMatch(/^text\/css/)
    expect(stylesheet.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await stylesheet.text()).toContain('prefers-color-scheme: dark')
    expect(home.html).not.toMatch(/<script|style="/)
  })
})
