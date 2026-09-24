import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { newRouter, type WebApplication } from '@caffeinejs/http'
import type { ListRender } from '@fastify/static'
import type { RouteOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { download, sendFile, staticFiles } from '../../index.js'
import { dist, expectNotFoundJSON, fixtures, isolated, NAVIGATION } from './_headers.js'

/**
 * File mounts in an application served under a base path.
 *
 * The server takes the base off a request's URL before routing — `request.url` and `req.raw.url` are that same
 * stripped value — so `@fastify/static` finds files by the path the application sees, and builds what it sends back
 * from it too. What it builds for the browser, a redirect's `Location` and a listing's links, has to get the base
 * back, or the browser leaves the application.
 */

const SECRET = 'base-path-session-secret-of-at-least-32-bytes'

/** Renders a listing as the links it was handed, so a test reads them back. */
const hrefs: ListRender = (dirs, files) => JSON.stringify([...dirs, ...files].map(entry => entry.href))

describe('a file mount under a base path', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  function site(): WebApplication {
    return isolated()
      .basePath('/api')
      .with(staticFiles(s => s.serve(fixtures, { prefix: '/static' }))) as WebApplication
  }

  it('serves a file under the base with its bytes, and the same file without the base', async () => {
    app = site()
    await app.ready()

    const expected = readFileSync(join(fixtures, 'hello.txt'), 'utf8')

    for (const url of ['/api/static/hello.txt', '/static/hello.txt']) {
      const res = await app.fetch(url)

      expect(res.status, url).toBe(200)
      expect(await res.text(), url).toBe(expected)
    }
  })

  it('keeps a miss under the mount a missing file', async () => {
    app = site()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/api/static/missing.txt', { headers: NAVIGATION }))
  })

  it('takes nothing off a path that only starts like the base', async () => {
    app = site()
    await app.ready()

    expect((await app.fetch('/apistatic/hello.txt')).status).toBe(404)
  })
})

describe('a redirecting mount under a base path', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  function site(): WebApplication {
    return isolated()
      .basePath('/api')
      .with(
        staticFiles(s =>
          s
            .serve(dist, { prefix: '/files', redirect: true })
            .serve(dist, { prefix: '/flat', redirect: true, wildcard: false, serve: true }),
        ),
      )
      .mount(
        newRouter().get('/app-go', ctx => {
          ctx.redirect('~/elsewhere')
        }),
      ) as WebApplication
  }

  it.each([
    ['/api/files', '/api/files/'],
    ['/api/files/assets?x=1', '/api/files/assets/?x=1'],
    ['/api/flat', '/api/flat/'],
  ])('redirects %s to %s, the base put back', async (url, location) => {
    app = site()
    await app.ready()

    const res = await app.fetch(url)

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(location)
  })

  it('redirects a request that came without the base without it', async () => {
    app = site()
    await app.ready()

    expect((await app.fetch('/files')).headers.get('location')).toBe('/files/')
  })

  // The hook runs for every reply the mount's routes send, and nearly all of them are files, not redirects.
  it('sends a file from the mount as it always has, with no Location', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/api/files/index.html')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(readFileSync(join(dist, 'index.html'), 'utf8'))
    expect(res.headers.get('location')).toBeNull()
  })

  // The hook belongs to the mount's routes, so a redirect the application builds itself — carrying the base
  // already — is never given a second one.
  it("leaves the application's own redirects alone", async () => {
    app = site()
    await app.ready()

    expect((await app.fetch('/api/app-go')).headers.get('location')).toBe('/api/elsewhere')
  })

  // The gate challenges on the mount's own routes, so its redirect passes through the same hook; it was built with
  // the base, and a second one would send the browser to `/api/api/login`.
  it('leaves the sign-in challenge on its routes with one base', async () => {
    app = isolated()
      .basePath('/api')
      .authentication(a => a.addCookie(o => o.sessionSecret(SECRET).secure(false).loginPath('/login')))
      .authorization(z => z.requireAuthenticatedByDefault())
      .with(staticFiles(s => s.serve(dist, { prefix: '/files', redirect: true }))) as WebApplication
    await app.ready()

    const res = await app.fetch('/api/files/index.html', { headers: NAVIGATION })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/login?returnUrl=%2Fapi%2Ffiles%2Findex.html')
  })
})

describe('a directory sendFile or download sends under a base path', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  // What `redirect` the reply `sendFile` returned holds, read back after the handler ran.
  let shadowed: boolean | undefined

  function site(basePath = '/api'): WebApplication {
    return isolated()
      .basePath(basePath)
      .with(staticFiles(s => s.serve(dist, { prefix: '/files', redirect: true })))
      .mount(
        newRouter()
          .get('/dir', ctx => sendFile(ctx, 'assets', dist))
          .get('/grab', ctx => download(ctx, 'assets', { root: dist }))
          .get('/page', ctx => {
            const reply = sendFile(ctx, 'index.html', dist)
            shadowed = Object.hasOwn(reply, 'redirect')
            return reply
          }),
      ) as WebApplication
  }

  it.each([
    ['/api/dir', '/api/dir/'],
    ['/api/dir?x=1', '/api/dir/?x=1'],
    ['/api/grab', '/api/grab/'],
    ['/dir', '/dir/'],
  ])('redirects %s to %s', async (url, location) => {
    app = site()
    await app.ready()

    const res = await app.fetch(url)

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(location)
  })

  it('sends a file under the base as it always has', async () => {
    app = site()
    await app.ready()

    const res = await app.fetch('/api/page')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(readFileSync(join(dist, 'index.html'), 'utf8'))
  })

  // Only a request that came under the base changes its reply; everything else keeps the shape Fastify gave it.
  it.each([
    ['no base path', '', '/page'],
    ['a request that came without the base', '/api', '/page'],
  ])('leaves the reply as it is with %s', async (_, basePath, url) => {
    app = site(basePath)
    await app.ready()
    shadowed = undefined

    expect((await app.fetch(url)).status).toBe(200)
    expect(shadowed).toBe(false)
  })
})

describe('what a mount pays under a base path', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  function collecting(registered: Map<string, RouteOptions>, basePath: string, redirect: boolean) {
    return isolated()
      .basePath(basePath)
      .serverCallback((_context, server) => {
        // By URL: `@fastify/static` registers its wildcard for `['HEAD', 'GET']` in one go.
        server.addHook('onRoute', route => {
          registered.set(route.url, route as RouteOptions)
        })
      })
      .with(staticFiles(s => s.serve(fixtures, { prefix: '/static', redirect })))
  }

  it('adds no hook to a mount that does not redirect', async () => {
    const registered = new Map<string, RouteOptions>()
    app = collecting(registered, '/api', false)
    await app.ready()

    expect(registered.has('/static/*')).toBe(true)
    expect(registered.get('/static/*')!.onSend).toBeUndefined()
  })

  it('adds no hook to a redirecting mount when there is no base path', async () => {
    const registered = new Map<string, RouteOptions>()
    app = collecting(registered, '', true)
    await app.ready()

    expect(registered.has('/static/*')).toBe(true)
    expect(registered.get('/static/*')!.onSend).toBeUndefined()
  })

  it('adds one to a redirecting mount under a base path', async () => {
    const registered = new Map<string, RouteOptions>()
    app = collecting(registered, '/api', true)
    await app.ready()

    expect(registered.get('/static/*')!.onSend).toBeDefined()
  })
})

describe('a listing mount under a base path', () => {
  let app: WebApplication

  afterEach(async () => {
    await app?.close()
  })

  function listing(basePath: string): WebApplication {
    return isolated()
      .basePath(basePath)
      .with(
        staticFiles(s => s.serve(dist, { prefix: '/listing', index: false, list: { format: 'html', render: hrefs } })),
      ) as WebApplication
  }

  it('renders its links under the base', async () => {
    app = listing('/api')
    await app.ready()

    const links = JSON.parse(await (await app.fetch('/api/listing/')).text()) as string[]

    expect(links).toContain('/api/listing/assets')
    expect(links).toContain('/api/listing/index.html')
  })

  // `render` gets no request, so the links carry the configured base; one still routes without it.
  it('renders the same links for a request that came without the base', async () => {
    app = listing('/api')
    await app.ready()

    const links = JSON.parse(await (await app.fetch('/listing/')).text()) as string[]

    expect(links).toContain('/api/listing/assets')
  })

  it('renders them as it always has without a base path', async () => {
    app = listing('')
    await app.ready()

    const links = JSON.parse(await (await app.fetch('/listing/')).text()) as string[]

    expect(links).toContain('/listing/assets')
    expect(links.some(link => link.startsWith('/api'))).toBe(false)
  })
})
