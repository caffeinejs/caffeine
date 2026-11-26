import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
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
 * A wildcard answers what follows its parent, never the parent itself: `/dash/*` does not answer `/dash`.
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

  // A wildcard answers what follows its parent, not the parent.
  it('leaves the parent of a wildcard to a route of its own', async () => {
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

      expect([bodies.map(([status]) => status), bodies[2]![1]]).toEqual([[404, 404, 200], '[a,b]'])
    } finally {
      await app.close()
    }
  })

  // A route at the parent answers it, its HEAD included.
  it("answers a route declared at a wildcard's parent", async () => {
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
})
