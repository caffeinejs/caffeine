import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, open, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Writable } from 'node:stream'

import { CaffeineIoC } from '@caffeinejs/di'
import { Authentication, Authorization, ErrConfiguration, RouteInventory, type WebApplication } from '@caffeinejs/http'
import { authentication, createWebApplication, newRouter, type HTTPPluginFactory } from '@caffeinejs/http/fastify'
import { Day, Millisecond, Second } from '@caffeinejs/std/duration'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'

import { buildStatic } from './build/build.js'
import type { MountOptions } from './config.js'
import { ErrStaticRouteConflict, ErrStaticScanInProduction } from './errors.js'
import { ErrStaticManifest, readManifest, type StaticManifest } from './manifest/manifest.js'
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

  // A request may name its target in absolute form, authority included: the router matches its path, so the lookup
  // must read the same path, or a folded name would miss.
  it('finds a file under a directory from an absolute-form request target, when the router folds case', async () => {
    const root = await tree('absolute', ['assets/App.js'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({
        factory: { routerOptions: { caseSensitive: false } },
        listener: { host: '127.0.0.1', port: 0 },
      }))
      .with(staticFiles(s => s.serve(root))) as WebApplication
    const { address } = await app.run()

    const res = await absoluteFormGet(address.origin, '/ASSETS/app.JS?v=1')

    expect(res).toEqual({ status: 200, body: 'assets/App.js' })
  })

  it.each(['i\u0307', '\u0130'])(
    'keeps the full file name when folding %s changes the directory length',
    async directory => {
      const root = await tree('folded', [`${directory}/report.txt`, `${directory}/xreport.txt`])
      app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .server(() => ({ factory: { routerOptions: { caseSensitive: false } } }))
        .with(staticFiles(s => s.serve(root))) as WebApplication
      await app.bootstrap()

      const res = await app.request('/%C4%B0/xreport.txt')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`${directory}/xreport.txt`)
    },
  )

  // Two directories that differ by case are one route to a router that folds case, and each file still its own URL.
  it('serves files under directories that differ by case as one route, when the router folds it', async () => {
    const root = await tree('dirs', ['Assets/a.js', 'assets/b.js'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { routerOptions: { caseSensitive: false } } }))
      .with(staticFiles(s => s.serve(root))) as WebApplication
    await app.bootstrap()

    expect(await (await app.request('/assets/a.js')).text()).toBe('Assets/a.js')
    expect(await (await app.request('/ASSETS/B.JS')).text()).toBe('assets/b.js')
  })

  it('serves disjoint files from mounts whose directory URLs differ by duplicate slashes', async () => {
    const one = await tree('one', ['assets/a.txt'])
    const two = await tree('two', ['assets/b.txt'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { routerOptions: { ignoreDuplicateSlashes: true } } }))
      .with(
        staticFiles(s => s.serve(one, { prefix: '/web//public' }).serve(two, { prefix: '/web/public' })),
      ) as WebApplication
    await app.bootstrap()

    expect(await (await app.request('/web/public/assets/a.txt')).text()).toBe('assets/a.txt')
    expect(await (await app.request('/web//public/assets/b.txt')).text()).toBe('assets/b.txt')
  })

  // The router keeps "%2F" as one segment's character while matching, then decodes it in the wildcard: read as "/", it
  // would reach a file by a URL that another route, gated differently, answers.
  it('answers 404 for an encoded slash under a directory', async () => {
    const root = await tree('nested', ['assets/private/report.txt'])
    await start(s => s.serve(root, { anonymous: true })).bootstrap()

    expect((await app!.request('/assets/private/report.txt')).status).toBe(200)
    expect((await app!.request('/assets/private%2Freport.txt')).status).toBe(404)
    expect((await app!.request('/assets/private%2freport.txt')).status).toBe(404)
  })

  // The router matches these escapes as written and decodes them in the wildcard, as with "%2F": an exact route at
  // the file's URL, gated its own way, answers only the literal spelling, so the wildcard answers none but that.
  it.each(['%24', '%26', '%2B', '%2b', '%2C', '%3B', '%3D', '%40'])(
    'answers 404 for %s under a directory, which an exact route would not match',
    async escape => {
      const name = `a${decodeURIComponent(escape)}b.txt`
      const root = await tree('nested', [`assets/${name}`])
      await start(s => s.serve(root, { anonymous: true })).bootstrap()

      expect((await app!.request(`/assets/${name}`)).status).toBe(200)
      expect((await app!.request(`/assets/a${escape}b.txt`)).status).toBe(404)
    },
  )

  // The 503 goes out while the open still waits, so nothing reads the descriptor it then gets: left open, every timed
  // out request would hold one until the process exits. A FIFO keeps the open waiting until a writer comes.
  it.skipIf(process.platform !== 'linux')('closes a file it opened after the handler timed out', async () => {
    const root = await tree('slow', ['slow.txt'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { handlerTimeout: 30 * Millisecond } }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()
    const fifo = join(await realpath(root), 'slow.txt')
    await rm(fifo)
    execFileSync('mkfifo', [fifo])

    expect((await app.request('/slow.txt')).status).toBe(503)

    // The writer's open completes the server's, and is then the only descriptor left on the FIFO.
    const writer = await open(fifo, 'w')
    try {
      await vi.waitFor(async () => expect(await descriptorsOn(fifo)).toBe(1))
    } finally {
      await writer.close()
    }
  })

  // Fastify aborts the timeout signal before it starts the 503, and the reply is not sent while a hook holds it: a
  // file opened then must not rewrite that response, nor go out over it.
  it.skipIf(process.platform !== 'linux')("leaves a timeout's 503 alone while a hook still holds it", async () => {
    const root = await tree('slow', ['slow.txt'])
    let holding!: () => void
    const started = new Promise<void>(resolve => (holding = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const plugin: FastifyPluginAsync = async instance => {
      instance.addHook('onSend', async (_request, reply, payload) => {
        if (reply.statusCode === 503) {
          holding()
          await held
        }

        return payload
      })
    }
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { handlerTimeout: 30 * Millisecond } }))
      .with(() => fp(plugin, { name: 'holding' }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()
    const fifo = join(await realpath(root), 'slow.txt')
    await rm(fifo)
    execFileSync('mkfifo', [fifo])

    const response = app.request('/slow.txt')
    await started
    // The writer's open completes the server's, and is then the only descriptor left on the FIFO.
    const writer = await open(fifo, 'w')
    try {
      await vi.waitFor(async () => expect(await descriptorsOn(fifo)).toBe(1))
    } finally {
      release()
      await writer.close()
    }

    const res = await response
    expect(res.status).toBe(503)
    expect(res.headers.get('etag')).toBe(null)
  })

  // Fastify's timer starts before the request hooks: a hook still running when it fires lets the handler start while
  // the 503 waits in `onSend`. A file removed after start-up then fails to open, and that failure is as late as the
  // file would have been.
  it("leaves a timeout's 503 alone when the file fails to open after it", async () => {
    const root = await tree('removed', ['gone.txt'])
    const holding = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const statuses: number[] = []
    const plugin: FastifyPluginAsync = async instance => {
      instance.addHook('onRequest', async () => {
        await holding.promise
      })
      instance.addHook('onSend', async (_request, reply, payload) => {
        statuses.push(reply.statusCode)
        if (reply.statusCode === 503) {
          holding.resolve()
          await held.promise
        }
        return payload
      })
    }
    const logs = new Writable({
      write(line: Buffer, _encoding, done) {
        if (line.toString().includes('Cannot open a static file the manifest lists')) {
          failed.resolve()
        }
        done()
      },
    })
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { handlerTimeout: 30 * Millisecond, logger: { level: 'error', stream: logs } } }))
      .with(() => fp(plugin, { name: 'holding' }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()
    await rm(join(root, 'gone.txt'))

    try {
      const response = app.request('/gone.txt')
      await failed.promise
      // The rejection and anything the server does with it run on microtasks, which drain before an immediate.
      await new Promise(resolve => setImmediate(resolve))
      held.resolve()

      expect((await response).status).toBe(503)
      expect(statuses).toEqual([503])
    } finally {
      held.resolve()
    }
  })

  // A miss under a directory is the handler's answer too, and as late as a file would have been.
  it("leaves a timeout's 503 alone when a directory finds no file after it", async () => {
    const root = await tree('nested', ['assets/app.js'])
    const holding = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const handling = Promise.withResolvers<void>()
    const statuses: number[] = []
    const plugin: FastifyPluginAsync = async instance => {
      instance.addHook('onRequest', async () => {
        await holding.promise
      })
      instance.addHook('preHandler', async () => {
        handling.resolve()
      })
      instance.addHook('onSend', async (_request, reply, payload) => {
        statuses.push(reply.statusCode)
        if (reply.statusCode === 503) {
          holding.resolve()
          await held.promise
        }
        return payload
      })
    }
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { handlerTimeout: 30 * Millisecond } }))
      .with(() => fp(plugin, { name: 'holding' }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()

    try {
      const response = app.request('/assets/missing.txt')
      await handling.promise
      // The handler runs right after the hook, and what the server does with its answer runs on microtasks.
      await new Promise(resolve => setImmediate(resolve))
      held.resolve()

      expect((await response).status).toBe(503)
      expect(statuses).toEqual([503])
    } finally {
      held.resolve()
    }
  })

  // A timed route's signal exists before its handler runs: only a timeout that fired keeps the file from going out.
  it('serves the file on a timed route', async () => {
    const root = await tree('timed', ['report.txt'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { handlerTimeout: 30 * Second } }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()

    const res = await app.request('/report.txt')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('report.txt')
  })

  // With the router reading ";" as the start of the query, an escape after it is the query's, not the path's.
  it('reads the path where the router does, when ";" starts the query', async () => {
    const root = await tree('nested', ['assets/app.js'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { useSemicolonDelimiter: true } }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()

    expect((await app.request('/assets/app.js;tag=a%2Bb')).status).toBe(200)
  })

  // Fastify's router reads a top-level flag that `routerOptions` leaves out, where `initialConfig` reports the default.
  it('reads the path where the router does, with ";" set apart from the other router options', async () => {
    const root = await tree('nested', ['assets/app.js'])
    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { useSemicolonDelimiter: true, routerOptions: { caseSensitive: false } } }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    await app.bootstrap()

    expect((await app.request('/assets/app.js;tag=a%2Bb')).status).toBe(200)
  })

  // No spelling reaches such a file: ";" ends the path, and "%3B" names nothing under a directory.
  it('fails start-up on a routed file with ";" in its name, when ";" starts the query', async () => {
    const root = await tree('nested', ['assets/report;final.txt'])

    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { useSemicolonDelimiter: true } }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication
    const err = await app.bootstrap().catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err as Error)).toBe(
      `Cannot serve "${root}": "assets/report;final.txt" holds ";", which useSemicolonDelimiter reads as the start of the query`,
    )
  })

  // The prefix is part of every URL the mount registers: ";" in it ends the path before any file's name.
  it('fails start-up on a prefix with ";" in it, when ";" starts the query', async () => {
    const root = await tree('nested', ['report.txt'])

    app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ factory: { useSemicolonDelimiter: true } }))
      .with(staticFiles(s => s.serve(root, { prefix: '/site;v1', anonymous: true }))) as WebApplication
    const err = await app.bootstrap().catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err as Error)).toBe(
      `Cannot serve "${root}": the prefix "/site;v1/" holds ";", which useSemicolonDelimiter reads as the start of the query`,
    )
  })

  // The router reads ":" and "*" in a prefix as a parameter and a wildcard: the files would answer URLs they do not have.
  it.each([
    ['/:lang', '":", which the router reads as a parameter'],
    ['/docs*', '"*", which the router reads as a wildcard'],
  ])('fails start-up on the prefix %s, which the router reads as syntax', async (prefix, why) => {
    const root = await tree('nested', ['report.txt'])

    const err = await refusal(s => s.serve(root, { prefix }))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err)).toBe(`Cannot serve "${root}": the prefix "${prefix}/" holds ${why}`)
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

  it('preserves quoted cache-control values that contain directive names', async () => {
    const cacheControl = 'no-cache="X-First, Public, X-Last"'
    await start(s => s.serve(spa, { cacheControl })).bootstrap()

    const res = await app!.request('/index.html')

    expect(res.headers.get('cache-control')).toBe(`private, ${cacheControl}`)
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

  // A Fastify reply would drop the header without a word: the application must hear of it at start-up.
  it('fails start-up on a header named __proto__ from headers(file)', async () => {
    const err = await refusal(s => s.serve(spa, { headers: () => ({ ['__proto__']: 'kept' }) }))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err)).toBe(
      `Cannot serve "${spa}": headers(file) returned "__proto__" for "assets/app-eZr2sdaR.js", which a reply cannot send`,
    )
  })

  it.each([
    [{ headers: () => ({ 'x-bad': 'first\nsecond' }) }, '"x-bad"'],
    [{ headers: () => ({ 'invalid name': 'value' }) }, '"invalid name"'],
    [{ cacheControl: 'max-age=1, ext="first\nsecond"' }, 'cacheControl'],
  ] as Array<[MountOptions, string]>)('refuses a header the server cannot send (%o)', async (options, header) => {
    const err = await refusal(s => s.serve(spa, options))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err)).toContain(header)
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
        { headers: () => ({ 'transfer-encoding': 'chunked' }) },
        `headers(file) returned "transfer-encoding" for "assets/app-eZr2sdaR.js", which the server computes`,
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

  // The ETag is the manifest's hash: bytes replaced at the same length after the build would be served under the old
  // one, and a cache holding the old bytes would revalidate them as current.
  it.each([
    ['the file', (_manifest: StaticManifest) => 'app.js'],
    ['a variant', (manifest: StaticManifest) => manifest.files['app.js']!.variants.br!.path],
  ])('fails start-up on %s replaced at the same length after the build', async (_case, pathOf) => {
    const root = join(dir, 'replaced')
    await mkdir(root)
    await writeFile(join(root, 'app.js'), 'console.log("a")\n'.repeat(100))
    await buildStatic({ root })
    const replaced = pathOf(await readManifest(root))
    const { size } = await stat(join(root, replaced))
    await writeFile(join(root, replaced), 'x'.repeat(size))

    const err = await refusal(s => s.serve(root))

    expect(err).toBeInstanceOf(ErrStaticManifest)
    expect(firstLine(err)).toBe(
      `Cannot serve "${root}": "${replaced}" changed after the build, its bytes no longer match the manifest's hash`,
    )
  })

  // A path is the application's text: "__proto__" is a file like any other, in the manifest and on the router.
  it('serves a file named __proto__', async () => {
    const root = join(dir, 'proto')
    await mkdir(root)
    await writeFile(join(root, '__proto__'), 'proto')
    await buildStatic({ root, types: { ['__proto__']: 'text/plain' } })
    await start(s => s.serve(root, { anonymous: true })).bootstrap()

    const res = await app!.request('/__proto__')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proto')
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

    it('refuses a nested mount when the folded prefix consumes the entire wildcard value', async () => {
      const prefix = `/${'İ'.repeat(24)}`
      const outer = await tree('outer', ['assets/inner/a.txt'])
      const inner = await tree('inner', ['inner/b.txt'])
      app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .server(() => ({ factory: { routerOptions: { caseSensitive: false } } }))
        .with(
          staticFiles(s => s.serve(outer, { prefix }).serve(inner, { prefix: `${prefix}/assets` })),
        ) as WebApplication

      await expect(app.bootstrap()).rejects.toThrow(ErrStaticRouteConflict)
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
      const upper = await tree('upper', ['A.txt'])
      const lower = await tree('lower', ['a.txt'])
      app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .server(() => ({ factory: { routerOptions: { caseSensitive: false } } }))
        .with(staticFiles(s => s.serve(upper).serve(lower))) as WebApplication

      const err = await app.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
    })

    // The mount's wildcard would otherwise answer the file by another spelling, under the mount's gate, not the route's.
    it('from a route registered before the mount at the URL of a file under a directory', async () => {
      const root = await tree('nested', ['assets/private/report.txt', 'assets/app.js'])
      const plugin: FastifyPluginAsync = async instance => {
        instance.get('/assets/private/report.txt', async () => 'protected')
      }
      const earlier: HTTPPluginFactory = () => plugin

      const err = await refusal(s => s.serve(root, { anonymous: true }), [earlier])

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/assets/private/report.txt": "${name(root, 'assets/private/report.txt')}" answers another route at that URL`,
      )
    })

    // Compiled routes are registered after every plugin: a gated one at a file's URL would answer the literal
    // spelling while the anonymous mount answered every other.
    it('from a route registered after the mount at the URL of a file under a directory', async () => {
      const root = await tree('nested', ['assets/private/report.txt', 'assets/app.js'])
      start(s => s.serve(root, { anonymous: true })).mount(
        newRouter().get('/assets/private/report.txt', () => 'protected'),
      )

      const err = await app!.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err as Error)).toBe(
        `Cannot register "/assets/private/report.txt": "${name(root, 'assets/private/report.txt')}" answers another route at that URL`,
      )
    })

    // The mount answers GET and HEAD alone: a form posting to a file's URL takes nothing from it.
    it('but not from a POST registered after the mount at the URL of a file under a directory', async () => {
      const root = await tree('nested', ['assets/private/report.txt'])
      start(s => s.serve(root, { anonymous: true })).mount(
        newRouter().post('/assets/private/report.txt', () => 'posted'),
      )
      await app!.bootstrap()

      expect(await (await app!.request('/assets/private/report.txt', { method: 'POST' })).text()).toBe('posted')
      expect(await (await app!.request('/assets/private/report.txt')).text()).toBe('assets/private/report.txt')
    })

    // A HEAD of its own answers the file's URL as a GET would: the mount's HEAD would answer every other spelling.
    it('from a HEAD registered before the mount at the URL of a file under a directory', async () => {
      const root = await tree('nested', ['assets/report.txt'])
      const plugin: FastifyPluginAsync = async instance => {
        instance.head('/assets/report.txt', async (_request, reply) => reply.send())
      }
      const earlier: HTTPPluginFactory = () => plugin

      const err = await refusal(s => s.serve(root, { anonymous: true }), [earlier])

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/assets/report.txt": "${name(root, 'assets/report.txt')}" answers another route at that URL`,
      )
    })

    // The router collapses the slashes when it registers the route, so it answers the file's own URL.
    it('from a route registered after the mount at a spelling of the URL the router folds', async () => {
      const root = await tree('nested', ['assets/report.txt'])
      const plugin: FastifyPluginAsync = async instance => {
        instance.get('/assets//report.txt', async () => 'later')
      }
      app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .server(() => ({ factory: { routerOptions: { ignoreDuplicateSlashes: true } } }))
        .with(staticFiles(s => s.serve(root, { anonymous: true })))
        .with(() => fp(plugin, { name: 'later' })) as WebApplication

      const err = await app.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
    })

    // The router folds the mount's prefix as it folds the other route's URL: both answer one path.
    it.each([
      ['before', true],
      ['after', false],
    ])(
      'from a route registered %s the mount at the folded URL of a file under a prefix the router folds',
      async (_case, before) => {
        const root = await tree('nested', ['assets/report.txt'])
        const plugin: FastifyPluginAsync = async instance => {
          instance.get('/web/public/assets/report.txt', async () => 'protected')
        }
        const other = () => fp(plugin, { name: 'other' })
        const mount = staticFiles(s => s.serve(root, { prefix: '/web//public', anonymous: true }))
        app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
          .server(() => ({ factory: { routerOptions: { ignoreDuplicateSlashes: true } } }))
          .with(before ? other : mount)
          .with(before ? mount : other) as WebApplication

        const err = await app.bootstrap().catch((err: unknown) => err)

        expect(err).toBeInstanceOf(ErrStaticRouteConflict)
        expect(firstLine(err as Error)).toBe(
          `Cannot register "/web//public/assets/report.txt": "${name(root, 'assets/report.txt')}" answers another route at that URL`,
        )
      },
    )

    // find-my-way registers the URL without the optional segment too: that route answers the file's own URL.
    it('from a route with an optional segment registered before the mount, which also answers the URL of a file', async () => {
      const root = await tree('nested', ['assets/report.txt'])
      const plugin: FastifyPluginAsync = async instance => {
        instance.get('/assets/report.txt/:lang?', async () => 'protected')
      }
      const earlier: HTTPPluginFactory = () => plugin

      const err = await refusal(s => s.serve(root, { anonymous: true }), [earlier])

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/assets/report.txt": "${name(root, 'assets/report.txt')}" answers another route at that URL`,
      )
    })

    // A parameter ranks above a wildcard: the route would answer every file directly under the directory.
    it('from a parametric route registered after the mount over a directory of files', async () => {
      const root = await tree('nested', ['assets/report.txt'])
      start(s => s.serve(root, { anonymous: true })).mount(newRouter().get('/assets/:name', () => 'protected'))

      const err = await app!.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err as Error)).toBe(
        `Cannot register "/assets/report.txt": "${name(root, 'assets/report.txt')}" answers another route at that URL`,
      )
    })

    // find-my-way reports a parameter named "*" as the wildcard's value: the check could not tell the two apart.
    it('from a route with a parameter named * over a directory of files', async () => {
      const root = await tree('nested', ['assets/report.txt'])
      start(s => s.serve(root, { anonymous: true })).mount(newRouter().get('/assets/:*', () => 'protected'))

      const err = await app!.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrConfiguration)
      expect(firstLine(err as Error)).toBe(
        'Cannot register "/assets/:*": a parameter named "*" reads as a wildcard, whose value has that name',
      )
    })

    // The router folds the prefixes as it folds any URL, and gives the file to the longer wildcard, which misses it.
    it('from a mount nested in another under a prefix the router folds', async () => {
      const outer = await tree('outer', ['assets/private/report.txt'])
      const inner = await tree('inner', ['private/other.txt'])
      app = createWebApplication({ container: new CaffeineIoC({ decorators: false }) })
        .server(() => ({ factory: { routerOptions: { ignoreDuplicateSlashes: true } } }))
        .with(
          staticFiles(s => s.serve(outer, { prefix: '/web//public' }).serve(inner, { prefix: '/web/public/assets' })),
        ) as WebApplication

      const err = await app.bootstrap().catch((err: unknown) => err)

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err as Error)).toBe(
        `Cannot register "/web//public/assets/private/report.txt": "${name(outer, 'assets/private/report.txt')}" and "${name(inner, 'private/other.txt')}" both answer it`,
      )
    })

    it('from a route registered before the mount', async () => {
      const plugin: FastifyPluginAsync = async instance => {
        instance.get('/hello.txt', async () => 'earlier')
      }
      const earlier: HTTPPluginFactory = () => plugin

      const err = await refusal(s => s.serve(fixtures), [earlier])

      expect(err).toBeInstanceOf(ErrStaticRouteConflict)
      expect(firstLine(err)).toBe(
        `Cannot register "/hello.txt": "${name(fixtures, 'hello.txt')}" answers another route at that URL`,
      )
    })

    // Only the router's duplicate is a conflict: another plugin's refusal of the route must reach the reader as written.
    it('but lets another error from registering a route through as it was thrown', async () => {
      const refused = new Error('refused by policy')
      const plugin: FastifyPluginAsync = async instance => {
        instance.addHook('onRoute', () => {
          throw refused
        })
      }
      const earlier: HTTPPluginFactory = () => fp(plugin, { name: 'policy' })

      expect(await refusal(s => s.serve(fixtures), [earlier])).toBe(refused)
    })
  })

  it('refuses a second staticFiles(...) on one server', async () => {
    app = start(s => s.serve(fixtures)).with(staticFiles(s => s.serve(spa, { prefix: '/app' }))) as WebApplication

    const err = await app.bootstrap().catch((err: unknown) => err)

    expect(firstLine(err as Error)).toBe('Cannot register plugin "@caffeinejs/static": it is already registered')
  })
})

/** How many of this process's descriptors are open on `path`. */
async function descriptorsOn(path: string): Promise<number> {
  const fds = await readdir('/proc/self/fd')
  const targets = await Promise.all(fds.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')))

  return targets.filter(target => target === path).length
}

// Node's client writes `path` as the request target verbatim, so a full URL goes out in absolute form.
function absoluteFormGet(origin: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(origin)

  return new Promise((resolve, reject) => {
    httpRequest({ host: hostname, port, path: `${origin}${path}` }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
      .on('error', reject)
      .end()
  })
}
