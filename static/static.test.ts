import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { CaffeineIoC } from '@caffeinejs/di'
import { Authentication, Authorization, ErrConfiguration, RouteInventory, type WebApplication } from '@caffeinejs/http'
import { authentication, createWebApplication, newRouter, type HTTPPluginFactory } from '@caffeinejs/http/fastify'
import { Day, Millisecond } from '@caffeinejs/std/duration'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'

import { buildStatic } from './build/build.js'
import type { MountOptions } from './config.js'
import { ErrStaticRouteConflict, ErrStaticScanInProduction } from './errors.js'
import { ErrStaticManifest } from './manifest/manifest.js'
import { staticFiles, type StaticConfigurer } from './static.js'

const { spa, fixtures } = inject('fixtures')

describe('staticFiles', () => {
  let app: WebApplication | undefined
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caffeine-static-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    app = undefined
    await rm(dir, { recursive: true, force: true })
  })

  /** A root holding `paths`, each file its own path as content, built unless `built` is false. */
  async function tree(name: string, paths: readonly string[], built = true): Promise<string> {
    const root = join(dir, name)

    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), path)
    }

    if (built) {
      await buildStatic({ root })
    }

    return root
  }

  /** An application that routes nothing but what it is given, so a `@Controller` elsewhere stays out. */
  function start(configure: StaticConfigurer, before: HTTPPluginFactory[] = []) {
    let builder = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })

    for (const plugin of before) {
      builder = builder.with(plugin)
    }

    app = builder.with(staticFiles(configure)) as WebApplication

    return app
  }

  async function refusal(configure: StaticConfigurer, before: HTTPPluginFactory[] = []): Promise<Error> {
    const err = await start(configure, before)
      .bootstrap()
      .catch((err: unknown) => err)

    expect(err).toBeInstanceOf(Error)

    return err as Error
  }

  const firstLine = (err: Error) => err.message.split('\n')[0]

  // Thousands of files must not mean thousands of routes: start-up and router memory grow with directories instead.
  it('registers a route per file at the root, per directory under it, and per index URL', async () => {
    await start(s => s.serve(spa, { prefix: '/app' })).bootstrap()

    const urls = app!.container
      .get(RouteInventory)
      .servers[0]!.routes.filter(route => route.kind === 'raw')
      .map(route => route.url)
      .toSorted()

    expect(urls).toEqual(['/app', '/app/', '/app/assets/*', '/app/favicon.svg', '/app/index.html'])
  })

  it('keeps off the router what unrouted names, index URLs included', async () => {
    await start(s => s.serve(spa, { unrouted: ['index.html'] })).bootstrap()

    expect((await app!.request('/index.html')).status).toBe(404)
    expect((await app!.request('/')).status).toBe(404)
    expect((await app!.request('/favicon.svg')).status).toBe(200)
  })

  // A file a directory route does not list is a 404 there, not a page of the application's catch-all.
  it('answers 404 for a miss under a directory, and leaves a miss at the root to the application', async () => {
    app = start(s => s.serve(spa)).mount(newRouter().get('/*', () => 'client route')) as WebApplication
    await app.bootstrap()

    expect((await app.request('/assets/missing.js')).status).toBe(404)
    expect(await (await app.request('/missing')).text()).toBe('client route')
  })

  // A 416 is not the file: a shared cache must not keep it for the file's lifetime.
  it('answers a range past the end with 416 and no Cache-Control', async () => {
    await start(s => s.serve(spa, { anonymous: true, immutable: ['assets/**'] })).bootstrap()

    const res = await app!.request('/assets/app-eZr2sdaR.js', { headers: { range: 'bytes=999999-' } })

    expect(res.status).toBe(416)
    expect(res.headers.get('cache-control')).toBe(null)
  })

  // A router that folds case folds a per-file route's URL; a directory route must answer the same URLs.
  it('finds a file under a directory by any case, when the router folds it', async () => {
    const root = await tree('folded', ['assets/App.js'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { routerOptions: { caseSensitive: false } } }))
      .with(staticFiles(s => s.serve(root))) as WebApplication
    await app.bootstrap()

    expect(await (await app.request('/ASSETS/app.JS')).text()).toBe('assets/App.js')
  })

  // The router takes the longest prefix, so neither mount hides the other, whichever is declared first.
  it.each([
    ['outer first', true],
    ['inner first', false],
  ])('serves a mount nested under another one, %s', async (_case, outerFirst) => {
    const outer = await tree('outer', ['assets/app.js'])
    const inner = await tree('inner', ['logo/a.png'])
    await start(s =>
      outerFirst
        ? s.serve(outer).serve(inner, { prefix: '/assets/img' })
        : s.serve(inner, { prefix: '/assets/img' }).serve(outer),
    ).bootstrap()

    expect(await (await app!.request('/assets/app.js')).text()).toBe('assets/app.js')
    expect(await (await app!.request('/assets/img/logo/a.png')).text()).toBe('logo/a.png')
  })

  describe('under requireAuthenticatedByDefault()', () => {
    function gated(options: MountOptions) {
      app = start(s => s.serve(spa, options))
        .install(Authentication(a => a.addCookie(o => o.sessionSecret('s'.repeat(32)).secure(false))))
        .with(authentication())
        .install(Authorization(z => z.requireAuthenticatedByDefault())) as WebApplication

      return app
    }

    it('serves an anonymous mount to everyone, as public', async () => {
      await gated({ anonymous: true }).bootstrap()

      const res = await app!.request('/favicon.svg')

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, no-cache')
    })

    // A mount that does not say so sits under the application's policy, which may be a cookie.
    it('refuses a mount that is not anonymous to a caller with no identity', async () => {
      await gated({}).bootstrap()

      expect((await app!.request('/favicon.svg')).status).toBe(401)
    })
  })

  // Without anonymous the response may depend on a cookie, and only private keeps it out of a shared cache.
  it('writes private Cache-Control on a mount that is not anonymous', async () => {
    await start(s => s.serve(spa)).bootstrap()

    expect((await app!.request('/favicon.svg')).headers.get('cache-control')).toBe('private, no-cache')
  })

  it('caches the files immutable names for immutableMaxAge, and the rest with cacheControl', async () => {
    await start(s =>
      s.serve(spa, { immutable: ['assets/**'], immutableMaxAge: 7 * Day, cacheControl: 'max-age=60', anonymous: true }),
    ).bootstrap()

    expect((await app!.request('/assets/app-eZr2sdaR.js')).headers.get('cache-control')).toBe(
      'public, max-age=604800, immutable',
    )
    expect((await app!.request('/favicon.svg')).headers.get('cache-control')).toBe('public, max-age=60')
  })

  it('adds what headers(file) returns, merging Vary', async () => {
    await start(s =>
      s.serve(spa, {
        headers: (file, path) => (path === 'index.html' ? { 'x-frame-options': 'DENY', vary: 'Cookie' } : undefined),
      }),
    ).bootstrap()

    const res = await app!.request('/index.html')

    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('vary')).toBe('Cookie, Accept-Encoding')
  })

  // A plugin such as @fastify/cors writes Vary: Origin first; replacing it lets a shared cache hand one origin's
  // Access-Control-Allow-Origin to another.
  it('keeps a Vary written before it, adding Accept-Encoding', async () => {
    const plugin: FastifyPluginAsync = async instance => {
      instance.addHook('onRequest', async (_request, reply) => {
        reply.header('vary', 'Origin')
      })
    }
    const varying: HTTPPluginFactory = () => fp(plugin, { name: 'varying' })

    await start(s => s.serve(spa, { anonymous: true }), [varying]).bootstrap()

    expect((await app!.request('/index.html')).headers.get('vary')).toBe('Origin, Accept-Encoding')
  })

  describe('refuses an option that overrides what the mount derives', () => {
    it.each([
      [{ cacheControl: 'public, max-age=60' }, `cacheControl names "public", which the mount derives from anonymous`],
      [
        { immutableMaxAge: 500 * Millisecond },
        'immutableMaxAge is 500ms, under the one second Cache-Control can carry',
      ],
      [
        { headers: () => ({ ETag: '"mine"' }) },
        `headers(file) returned "etag" for "assets/app-eZr2sdaR.js", which the server computes`,
      ],
      [
        { headers: () => ({ 'cache-control': 'no-store' }) },
        `headers(file) returned "cache-control" for "assets/app-eZr2sdaR.js", which the server computes`,
      ],
    ] as Array<[MountOptions, string]>)('%o', async (options, detail) => {
      const err = await refusal(s => s.serve(spa, options))

      expect(err).toBeInstanceOf(ErrConfiguration)
      expect(firstLine(err)).toBe(`Cannot serve "${spa}": ${detail}`)
    })
  })

  // Forgetting the build step must fail the deployment, not answer every request with a 404.
  it('fails start-up on a root with no manifest', async () => {
    const root = await tree('unbuilt', ['index.html'], false)

    const err = await refusal(s => s.serve(root))

    expect(err).toBeInstanceOf(ErrStaticManifest)
    expect(firstLine(err)).toBe(`Cannot serve "${root}": static.manifest.json is missing`)
  })

  describe('in scan mode', () => {
    it('serves a snapshot of the root taken at start-up', async () => {
      const root = await tree('dev', ['index.html'], false)
      await start(s => s.serve(root, { mode: 'scan' })).bootstrap()
      await writeFile(join(root, 'later.html'), 'later')

      expect(await (await app!.request('/index.html')).text()).toBe('index.html')
      expect((await app!.request('/later.html')).status).toBe(404)
    })

    // A scan hashes every file at start-up and compresses nothing: a production server pays that on every boot.
    it('is refused in production', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const root = await tree('dev', ['index.html'], false)

      const err = await refusal(s => s.serve(root, { mode: 'scan' }))

      expect(err).toBeInstanceOf(ErrStaticScanInProduction)
      expect((err as ErrStaticScanInProduction).code).toBe('ERR_STATIC_SCAN_IN_PRODUCTION')
    })

    it('is served in production after allowProduction()', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const root = await tree('dev', ['index.html'], false)

      await start(s => s.serve(root, { mode: 'scan' }).allowProduction()).bootstrap()

      expect((await app!.request('/index.html')).status).toBe(200)
    })
  })

  describe('refuses two answers for one URL', () => {
    const name = (root: string, path: string) => relative(process.cwd(), join(root, path))

    it('from two mounts', async () => {
      const one = await tree('one', ['a.txt'])
      const two = await tree('two', ['a.txt'])

      const err = await refusal(s => s.serve(one).serve(two))

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/a.txt": "${name(one, 'a.txt')}" and "${name(two, 'a.txt')}" both answer it`,
      )
    })

    // find-my-way takes the longest wildcard: the nested mount's directory route would answer, and miss, the other's file.
    it("from a mount whose directory route takes in another mount's directory", async () => {
      const outer = await tree('outer', ['static/img/a.png'])
      const inner = await tree('inner', ['img/b.png'])

      const err = await refusal(s => s.serve(outer).serve(inner, { prefix: '/static' }))

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/static/img/a.png": "${name(outer, 'static/img/a.png')}" and "${name(inner, 'img/b.png')}" both answer it`,
      )
    })

    // One route carries one gate: merging the two would expose the protected files or lock out the public ones.
    it('from two mounts sharing a directory that disagree on anonymous', async () => {
      const open = await tree('open', ['assets/a.js'])
      const closed = await tree('closed', ['assets/b.js'])

      const err = await refusal(s => s.serve(open, { anonymous: true }).serve(closed))

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/assets/*": "${name(open, 'assets/a.js')}" and "${name(closed, 'assets/b.js')}" both answer it`,
      )
    })

    // A router that folds case reaches both files by one URL; which one answers would be an accident.
    it('from two files that differ by case, when the router folds it', async () => {
      const root = await tree('cased', ['A.txt', 'a.txt'])
      app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .server(() => ({ factory: { routerOptions: { caseSensitive: false } } }))
        .with(staticFiles(s => s.serve(root))) as WebApplication

      const err = await app.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
    })

    it('from a route registered before the mount', async () => {
      const plugin: FastifyPluginAsync = async instance => {
        instance.get('/hello.txt', async () => 'earlier')
      }
      const earlier: HTTPPluginFactory = () => plugin

      const err = await refusal(s => s.serve(fixtures), [earlier])

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/hello.txt": "${name(fixtures, 'hello.txt')}" answers a route registered before it`,
      )
    })
  })

  it('refuses a second staticFiles(...) on one server', async () => {
    app = start(s => s.serve(fixtures)).with(staticFiles(s => s.serve(spa, { prefix: '/app' }))) as WebApplication

    const err = await app.bootstrap().catch((err: unknown) => err)

    expect(firstLine(err as Error)).toBe('Cannot register plugin "@caffeinejs/static": it is already registered')
  })
})
