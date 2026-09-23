import fp from 'fastify-plugin'
import { describe, expect, it } from 'vitest'

import { Controller, Get, createWebApplication, newRouter, type WebApplication } from '../index.js'

/**
 * What a group's prefix and a route at `/` compose to.
 *
 * Load-bearing for every prefixed application, and it was asserted only in prose until this file: the
 * documentation claimed `newRouter('/app')` with a route at `/` produced `/app/` and therefore did not answer
 * `GET /app`. It produces `/app` — `joinPaths` trims the trailing slash — and since the adapter leaves
 * Fastify's `ignoreTrailingSlash` off, `/app/` is then a different URL that nothing registered.
 *
 * The consequence that survives is the wildcard's: `/dash/*` does not match the bare `/dash`, which is why a
 * gated subtree still needs two routes.
 */

/**
 * Collects every URL the application registers, from a plugin's `onRoute` hook.
 *
 * A plugin rather than `app.instance`: compiled routes register after every plugin, and the instance is not
 * reachable until `ready()` — by which point the routes have already gone past.
 */
function collectURLs(urls: string[]) {
  return () =>
    fp(
      async instance => {
        instance.addHook('onRoute', route => {
          urls.push(route.url)
        })
      },
      { name: 'collect-urls' },
    )
}

describe('a group prefix and a route at "/"', () => {
  it('composes to the bare prefix, not to a trailing slash', async () => {
    const urls: string[] = []
    const app = createWebApplication({})
      .with(collectURLs(urls))
      .mount(newRouter('/app').get('/', () => ({ ok: true }))) as WebApplication
    await app.ready()

    try {
      expect(urls).toContain('/app')
      expect(urls).not.toContain('/app/')
    } finally {
      await app.close()
    }
  })

  it('answers the bare path and not the trailing slash', async () => {
    const app = createWebApplication({}).mount(newRouter('/app').get('/', () => ({ ok: true }))) as WebApplication
    await app.ready()

    try {
      expect((await app.fetch('/app')).status).toBe(200)
      // `ignoreTrailingSlash` is left at Fastify's default, so this is a different URL.
      expect((await app.fetch('/app/')).status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('composes a nested mount the same way', async () => {
    const urls: string[] = []
    const app = createWebApplication({})
      .with(collectURLs(urls))
      .mount(newRouter('/api').mount(newRouter('/v1').get('/', () => ({ ok: true })))) as WebApplication
    await app.ready()

    try {
      expect(urls).toContain('/api/v1')
      expect((await app.fetch('/api/v1')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('composes a decorated controller the same way', async () => {
    @Controller('/ctrl')
    class RootController {
      @Get('/')
      root(): unknown {
        return { ok: true }
      }
    }
    void [RootController]

    const app = createWebApplication({}) as WebApplication
    await app.ready()

    try {
      expect((await app.fetch('/ctrl')).status).toBe(200)
    } finally {
      await app.close()
    }
  })

  // The half of the documented papercut that is real: a wildcard covers the empty match but not the bare path.
  it('does not match a bare path against a sibling wildcard', async () => {
    const app = createWebApplication({}).mount(newRouter().get('/dash/*', () => ({ ok: true }))) as WebApplication
    await app.ready()

    try {
      expect((await app.fetch('/dash')).status).toBe(404)
      expect((await app.fetch('/dash/')).status).toBe(200)
      expect((await app.fetch('/dash/deep')).status).toBe(200)
    } finally {
      await app.close()
    }
  })
})
