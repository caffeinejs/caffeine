import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { CaffeineIoC } from '@caffeinejs/di'
import {
  Authentication,
  authentication,
  Authorization,
  ErrConfiguration,
  findMyWayMatcher,
  Guards,
  HTTPPlugin,
  Router,
  type HTTPPluginFactory,
  type Guard,
  type HTTPSetupContext,
  createWebApplication,
  type WebApplication,
} from '@caffeinejs/http'
import { node, type NodeAdapter } from '@caffeinejs/http-node'
import { Day, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'

import { buildStatic } from './build/build.js'
import type { MountOptions } from './config.js'
import { ErrStaticRouteConflict, ErrStaticScanInProduction } from './errors.js'
import { ErrStaticManifest, type StaticManifest } from './manifest/manifest.js'
import { readManifest } from './manifest/read.js'
import { staticFiles, type StaticConfigurer } from './static.js'

const { spa, fixtures } = inject('fixtures')

describe('staticFiles', () => {
  let app: WebApplication<never, never, unknown, NodeAdapter> | undefined
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

  /** A plugin whose `register` runs `setup` on the application's own registrar. */
  function plugin(setup: (server: HTTPSetupContext['server']) => void): HTTPPluginFactory {
    return () =>
      new (class extends HTTPPlugin {
        register({ server }: HTTPSetupContext) {
          setup(server)
        }
      })()
  }

  /** An application that routes nothing but what it is given, so a `@Controller` elsewhere stays out. */
  function start(configure: StaticConfigurer, before: Array<HTTPPluginFactory> = []) {
    let builder = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })

    for (const plugin of before) {
      builder = builder.with(plugin)
    }

    app = builder.with(staticFiles(configure)) as WebApplication<never, never, unknown, NodeAdapter>

    return app
  }

  async function refusal(configure: StaticConfigurer, before: Array<HTTPPluginFactory> = []): Promise<Error> {
    const err = await start(configure, before)
      .bootstrap()
      .catch((err: unknown) => err)

    expect(err).toBeInstanceOf(Error)

    return err as Error
  }

  const firstLine = (err: Error) => err.message.split('\n')[0]

  // Thousands of files must not mean thousands of routes: start-up and router memory grow with directories instead.
  it('registers a route per file at the root, per directory under it, and per index URL', async () => {
    const urls: string[] = []
    const collecting = plugin(app => {
      app.hook('onRoute', route => {
        urls.push(route.url)
      })
    })
    await start(s => s.serve(spa, { prefix: '/app' }), [collecting]).bootstrap()
    const index = await readFile(join(spa, 'index.html'), 'utf8')

    expect(urls.toSorted()).toEqual(['/app', '/app/assets/*', '/app/favicon.svg', '/app/index.html'])
    const slashed = await app!.request('/app/')
    const bare = await app!.request('/app')
    expect(slashed.status).toBe(200)
    expect(await slashed.text()).toBe(index)
    expect(bare.status).toBe(200)
    expect(await bare.text()).toBe(index)
  })

  it('keeps off the router what unrouted names, index URLs included', async () => {
    await start(s => s.serve(spa, { unrouted: ['index.html'] })).bootstrap()

    expect((await app!.request('/index.html')).status).toBe(404)
    expect((await app!.request('/')).status).toBe(404)
    expect((await app!.request('/favicon.svg')).status).toBe(200)
  })

  // A file a directory route does not list is a 404 there, not a page of the application's catch-all.
  it('answers 404 for a miss under a directory, and leaves a miss at the root to the application', async () => {
    app = start(s => s.serve(spa)).mount(new Router().get('/*', () => 'client route')) as WebApplication<
      never,
      never,
      unknown,
      NodeAdapter
    >
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

  // A request may name its target in absolute form, authority included: the router matches its path, so the lookup
  // must take the scope's segments off that path, or an escape in a parameter's value would read as part of the file's.
  it('finds a file under a directory under a router from an absolute-form request target', async () => {
    const root = await tree('absolute', ['assets/App.js'])
    app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ listen: { host: '127.0.0.1', port: 0 } }))
      .mount(new Router('/tenants/:id').with(staticFiles(s => s.serve(root)))) as WebApplication<
      never,
      never,
      unknown,
      NodeAdapter
    >
    const { address } = await app.run()

    const res = await absoluteFormGet(address.origin, '/tenants/a%2Bb/assets/App.js?v=1')

    expect(res).toEqual({ status: 200, body: 'assets/App.js' })
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
    app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ handlerTimeout: 30 * Millisecond }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication<never, never, unknown, NodeAdapter>
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

  // The engine aborts the timeout signal before it answers 503, and a hook may hold the answer: a file opened then
  // must not rewrite that response, nor go out over it.
  it.skipIf(process.platform !== 'linux')("leaves a timeout's 503 alone while a hook still holds it", async () => {
    const root = await tree('slow', ['slow.txt'])
    let holding!: () => void
    const started = new Promise<void>(resolve => (holding = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const holder = plugin(app => {
      app.hook('onSend', async ctx => {
        if (ctx.statusCode === 503) {
          holding()
          await held
        }
      })
    })
    app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ handlerTimeout: 30 * Millisecond }))
      .with(holder)
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication<never, never, unknown, NodeAdapter>
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

  // A timed route's signal exists before its handler runs: only a timeout that fired keeps the file from going out.
  it('serves the file on a timed route', async () => {
    const root = await tree('timed', ['report.txt'])
    app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ handlerTimeout: 30 * Second }))
      .with(staticFiles(s => s.serve(root, { anonymous: true }))) as WebApplication<never, never, unknown, NodeAdapter>
    await app.bootstrap()

    const res = await app.request('/report.txt')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('report.txt')
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
        .install(Authorization(z => z.requireAuthenticatedByDefault())) as WebApplication<
        never,
        never,
        unknown,
        NodeAdapter
      >

      return app
    }

    it('serves an anonymous mount to everyone, as public', async () => {
      await gated({ anonymous: true }).bootstrap()

      const res = await app!.request('/favicon.svg')

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, no-cache')
    })

    it('serves an anonymous mount past a global guard that denies', async () => {
      class DenyAll implements Guard {
        guard() {
          return false
        }
      }
      app = start(s => s.serve(spa, { anonymous: true }).serve(fixtures, { prefix: '/private' }))
        .install(Authentication(a => a.addCookie(o => o.sessionSecret('s'.repeat(32)).secure(false))))
        .with(authentication())
        .install(Authorization(z => z.requireAuthenticatedByDefault()))
        .install(Guards(g => g.global(DenyAll))) as WebApplication<never, never, unknown, NodeAdapter>
      app.container.bind(DenyAll, t => t.toSelf())
      await app.bootstrap()

      expect((await app.request('/favicon.svg')).status).toBe(200)
      expect((await app.request('/private/hello.txt')).status).toBe(401)
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

  // A plugin such as corsPolicy() writes Vary: Origin first; replacing it lets a shared cache hand one origin's
  // Access-Control-Allow-Origin to another.
  it('keeps a Vary written before it, adding Accept-Encoding', async () => {
    const varying = plugin(app => {
      app.hook('onRequest', ctx => {
        ctx.header('vary', 'Origin')
      })
    })

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

    // The mount answers GET and HEAD alone: a form posting to a file's URL takes nothing from it.
    it('but not from a POST registered after the mount at the URL of a file under a directory', async () => {
      const root = await tree('nested', ['assets/private/report.txt'])
      start(s => s.serve(root, { anonymous: true })).mount(
        new Router().post('/assets/private/report.txt', () => 'posted'),
      )
      await app!.bootstrap()

      expect(await (await app!.request('/assets/private/report.txt', { method: 'POST' })).text()).toBe('posted')
      expect(await (await app!.request('/assets/private/report.txt')).text()).toBe('assets/private/report.txt')
    })

    // Only the router's duplicate is a conflict: another plugin's refusal of the route must reach the reader as written.
    it('but lets another error from registering a route through as it was thrown', async () => {
      const refused = new Error('refused by policy')
      const earlier = plugin(app => {
        app.hook('onRoute', () => {
          throw refused
        })
      })

      expect(await refusal(s => s.serve(fixtures), [earlier])).toBe(refused)
    })
  })

  // Two are the user's to register: both serve, each at its own prefix.
  it('serves two staticFiles(...) on one server, each at its prefix', async () => {
    app = start(s => s.serve(fixtures)).with(staticFiles(s => s.serve(spa, { prefix: '/app' }))) as WebApplication<
      never,
      never,
      unknown,
      NodeAdapter
    >
    await app.bootstrap()
    const index = await readFile(join(spa, 'index.html'), 'utf8')

    const hello = await app.request('/hello.txt')
    const spaIndex = await app.request('/app')
    expect([hello.status, (await hello.text()).trim(), spaIndex.status, await spaIndex.text()]).toEqual([
      200,
      'hello static world',
      200,
      index,
    ])
  })

  describe('on a router', () => {
    function routed(router: Router<any, any, any, any, any>): WebApplication<never, never, unknown, NodeAdapter> {
      app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) }).mount(
        router,
      ) as WebApplication<never, never, unknown, NodeAdapter>
      return app
    }

    // A plugin serves where it is registered: under a router, the router's path leads every file URL.
    it("serves files under the router's path", async () => {
      await routed(new Router('/r').with(staticFiles(s => s.serve(fixtures)))).bootstrap()

      const res = await app!.request('/r/hello.txt')
      expect([res.status, (await res.text()).trim()]).toEqual([200, 'hello static world'])
      expect((await app!.request('/hello.txt')).status).toBe(404)
    })

    // An index answers at its directory's path, with and without the slash, so the page's relative links resolve. A
    // mount with no prefix of its own starts at the router's path, which answers the same way.
    it.each([
      ['/app', '/r/app'],
      [undefined, '/r'],
    ])("answers a mount's index at its prefix %j under the router, with and without the slash", async (prefix, at) => {
      await routed(new Router('/r').with(staticFiles(s => s.serve(spa, { prefix })))).bootstrap()
      const index = await readFile(join(spa, 'index.html'), 'utf8')

      const bare = await app!.request(at)
      const slashed = await app!.request(`${at}/`)
      expect([bare.status, await bare.text(), slashed.status, await slashed.text()]).toEqual([200, index, 200, index])
    })

    // What the router's path matched is the router's: an escape in a parameter's value is no part of the file's URL,
    // and a "/" inside a parameter's pattern is no segment of it.
    it.each([
      ['/tenants/:id', 'escaped', '/tenants/a%2Bb/assets/App.js'],
      ['/tenants/:id([^/]+)', 'regex', '/tenants/42/assets/App.js'],
      ['/release(v1/files)', 'parenthesis', '/release(v1/files)/assets/App.js'],
    ])('finds a file under a directory under %s', async (path, name, url) => {
      const root = await tree(`scoped-${name}`, ['assets/App.js'])
      app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) }).mount(
        new Router(path).with(staticFiles(s => s.serve(root))),
      ) as WebApplication<never, never, unknown, NodeAdapter>
      await app.bootstrap()

      const res = await app.request(url)
      expect([res.status, await res.text()]).toEqual([200, 'assets/App.js'])
    })
  })

  it('refuses staticFiles() on a server with a matcher of its own', async () => {
    app = createWebApplication({ adapter: node(), container: new CaffeineIoC({ decorators: false }) })
      .server(() => ({ matcher: (flags, strategies) => findMyWayMatcher(flags, strategies) }))
      .with(staticFiles(s => s.serve(fixtures))) as WebApplication<never, never, unknown, NodeAdapter>

    const err = await app.bootstrap().catch((err: unknown) => err)

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err as Error)).toBe(
      'Cannot install staticFiles(): the server matches routes with a matcher of its own, and static routes are matched by find-my-way',
    )
  })

  it('refuses a prefix with an empty segment', async () => {
    const err = await refusal(s => s.serve(fixtures, { prefix: '/a//b' }))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(firstLine(err)).toBe(`Cannot use the path "/a//b": it holds an empty segment, "//"`)
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
