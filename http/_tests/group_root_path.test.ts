import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { version } from '../core/constraints/route.js'
import {
  Controller,
  Get,
  HTTPPlugin,
  type ActionResult,
  type HTTPSetupContext,
  type WebApplication,
  Router,
} from '../index.js'
import { node } from '../platform/node.testkit.js'

/**
 * What a group's prefix and a route at `/` compose to.
 *
 * Load-bearing for every prefixed application, and it was asserted only in prose until this file: the
 * documentation claimed `new Router('/app')` with a route at `/` produced `/app/` and therefore did not answer
 * `GET /app`. It produces `/app`, the group's own path, and the server answers it at `/app/` too: a trailing slash
 * never makes another route.
 *
 * A wildcard answers its bare parent too: `/dash/*` matches `/dash`, unless a route is declared at that path, whatever
 * its parameter names, or reaches it with its optional last segment.
 */

/**
 * Collects every URL the application registers, from a plugin's `onRoute` hook.
 *
 * A plugin rather than `app.instance`: the instance is not reachable until `bootstrap()` — by which point the
 * routes have already gone past.
 */
function collectURLs(urls: string[]) {
  return () =>
    new (class extends HTTPPlugin {
      override readonly name = 'collect-urls'

      register({ server }: HTTPSetupContext): void {
        server.hook('onRoute', r => void urls.push(r.url))
      }
    })()
}

describe('a group prefix and a route at "/"', () => {
  it('composes to the bare prefix, not to a trailing slash', async () => {
    const urls: string[] = []
    const app = createWebApplication({ adapter: node() })
      .with(collectURLs(urls))
      .mount(new Router('/app').get('/', () => ({ ok: true }))) as WebApplication
    await app.bootstrap()

    try {
      expect(urls).toContain('/app')
      expect(urls).not.toContain('/app/')
    } finally {
      await app.close()
    }
  })

  it('answers the bare path and the trailing slash', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router('/app').get('/', () => ({ ok: true })),
    ) as WebApplication
    await app.bootstrap()

    try {
      expect((await app.request('/app')).status).toBe(200)
      // A trailing slash never makes another route.
      expect((await app.request('/app/')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('composes a nested mount the same way', async () => {
    const urls: string[] = []
    const app = createWebApplication({ adapter: node() })
      .with(collectURLs(urls))
      .mount(new Router('/api').mount(new Router('/v1').get('/', () => ({ ok: true })))) as WebApplication
    await app.bootstrap()

    try {
      expect(urls).toContain('/api/v1')
      expect((await app.request('/api/v1')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('composes a decorated controller the same way', async () => {
    @Controller('/ctrl')
    class RootController {
      @Get('/')
      root(): ActionResult {
        return { ok: true }
      }
    }
    void [RootController]

    const app = createWebApplication({ adapter: node() }) as WebApplication
    await app.bootstrap()

    try {
      expect((await app.request('/ctrl')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // A gated subtree needs one route: the wildcard answers the bare path with an empty `*`, so a handler that reads it
  // works there too, its automatic HEAD included.
  it('answers the bare parent of a wildcard with an empty wildcard', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router().get('/dash/*', ctx => `[${(ctx.req.param('*') ?? 'missing').split('/').join(',')}]`),
    ) as WebApplication
    await app.bootstrap()

    try {
      const bodies = []
      for (const url of ['/dash', '/dash/', '/dash/a/b']) {
        const res = await app.request(url)
        bodies.push([res.status, await res.text()])
      }

      expect(bodies).toEqual([
        [200, '[]'],
        [200, '[]'],
        [200, '[a,b]'],
      ])
      expect((await app.request('/dash', { method: 'HEAD' })).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // Declared after the wildcard, the route at the parent still answers it, its HEAD included.
  it('leaves the bare parent to a route declared there', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router()
        .get('/dash/*', () => 'wildcard')
        .get('/dash', ctx => {
          ctx.header('x-route', 'parent')
          return 'parent'
        }),
    ) as WebApplication
    await app.bootstrap()

    try {
      const get = await app.request('/dash')
      const head = await app.request('/dash', { method: 'HEAD' })

      expect([await get.text(), head.status, head.headers.get('x-route')]).toEqual(['parent', 200, 'parent'])
    } finally {
      await app.close()
    }
  })

  // find-my-way tells routes apart by their constraints too: the bare parent gives way to a declared route whatever
  // its constraints, so a request the declared route does not take is not handed to the wildcard instead.
  it('leaves the bare parent to a constrained route declared there', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router().get('/dash/*', () => 'wildcard'),
      new Router().config(version('1.0.0')).get('/dash', () => 'parent'),
    ) as WebApplication
    await app.bootstrap()

    try {
      expect((await app.request('/dash')).status).toBe(404)
      expect(await (await app.request('/dash', { headers: { 'accept-version': '1.0.0' } })).text()).toBe('parent')
    } finally {
      await app.close()
    }
  })

  // find-my-way files a path by its parameters' places, not their names, and a route with an optional last segment at
  // both of its forms: the bare parent gives way to a route declared at any of them.
  it.each([
    ['another parameter name', '/t/:id', '/t/:tid/*', '/t/1'],
    ['an optional segment, at its shorter form', '/t/:id?', '/t/*', '/t'],
    ['an optional segment, at its longer form', '/t/:id?', '/t/:x/*', '/t/1'],
  ])('leaves the bare parent to a constrained route declared there under %s', async (_, declared, wildcard, url) => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router().get(wildcard, () => 'wildcard'),
      new Router().config(version('1.0.0')).get(declared, () => 'parent'),
    ) as WebApplication
    await app.bootstrap()

    try {
      expect([
        (await app.request(url)).status,
        await (await app.request(url, { headers: { 'accept-version': '1.0.0' } })).text(),
      ]).toEqual([404, 'parent'])
    } finally {
      await app.close()
    }
  })

  // A constrained GET registers a HEAD twin: a wildcard that declares HEAD itself gives its bare parent's HEAD way too,
  // so HEAD answers where GET does.
  it("leaves the bare parent's HEAD to a constrained route's HEAD twin", async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router().all('/t/:x/*', () => 'wildcard'),
      new Router().config(version('1.0.0')).get('/t/:id', () => 'parent'),
    ) as WebApplication
    await app.bootstrap()

    try {
      expect([
        (await app.request('/t/1', { method: 'HEAD' })).status,
        (await app.request('/t/1', { method: 'HEAD', headers: { 'accept-version': '1.0.0' } })).status,
      ]).toEqual([404, 200])
    } finally {
      await app.close()
    }
  })
})
