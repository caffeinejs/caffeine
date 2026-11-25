import { Router, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'
import { describe, expect, it } from 'vitest'

import { HTML, html } from './index.js'

describe('html()', () => {
  // The plugin writes what it resolved for each route: the route option is all HTML() reads.
  it('writes autoDoctype true to the routes of an html() given no settings', async () => {
    const app = createWebApplication({ adapter: node() })
      .with(html())
      .mount(new Router('/opts').get('/').handler(ctx => ({ html: ctx.options.html ?? null })))
    await app.bootstrap()

    expect(await (await app.request('/opts')).json()).toEqual({ html: { autoDoctype: true } })

    await app.close()
  })

  it("lets a route's html option win over the plugin's setting", async () => {
    const app = createWebApplication({ adapter: node() })
      .with(html(() => ({ autoDoctype: true })))
      .mount(
        new Router('/route-wins')
          .get('/')
          .config({ html: { autoDoctype: false } })
          .handler(() => HTML('<html><body>x</body></html>')),
      )
    await app.bootstrap()

    expect(await (await app.request('/route-wins')).text()).toBe('<html><body>x</body></html>')

    await app.close()
  })

  // Registered twice over one route, the two are not reconciled: the outer one writes first, and the inner one
  // reads that value as the route's own.
  it('keeps the outer html() setting when a router registers one too', async () => {
    const app = createWebApplication({ adapter: node() })
      .with(html(() => ({ autoDoctype: false })))
      .mount(
        new Router('/nested-html')
          .with(html(() => ({ autoDoctype: true })))
          .get('/')
          .handler(() => HTML('<html><body>x</body></html>')),
      )
    await app.bootstrap()

    expect(await (await app.request('/nested-html')).text()).toBe('<html><body>x</body></html>')

    await app.close()
  })
})
