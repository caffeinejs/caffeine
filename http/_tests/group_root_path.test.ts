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
 * `GET /app`. It produces `/app` — `joinPaths` trims the trailing slash — and since the application leaves
 * `ignoreTrailingSlash` off, `/app/` is then a different URL that nothing registered.
 *
 * The consequence that survives is the wildcard's: `/dash/*` does not match the bare `/dash`, which is why a
 * gated subtree still needs two routes.
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

  it('answers the bare path and not the trailing slash', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router('/app').get('/', () => ({ ok: true })),
    ) as WebApplication
    await app.bootstrap()

    try {
      expect((await app.request('/app')).status).toBe(200)
      // `ignoreTrailingSlash` is left at its default, so this is a different URL.
      expect((await app.request('/app/')).status).toBe(404)
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

  // The half of the documented papercut that is real: a wildcard covers the empty match but not the bare path.
  it('does not match a bare path against a sibling wildcard', async () => {
    const app = createWebApplication({ adapter: node() }).mount(
      new Router().get('/dash/*', () => ({ ok: true })),
    ) as WebApplication
    await app.bootstrap()

    try {
      expect((await app.request('/dash')).status).toBe(404)
      expect((await app.request('/dash/')).status).toBe(200)
      expect((await app.request('/dash/deep')).status).toBe(200)
    } finally {
      await app.close()
    }
  })
})
