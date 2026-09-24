import type { IncomingMessage } from 'node:http'

import { token } from '@caffeinejs/di'
import { $t, ErrApplicationStarted, newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Controller,
  ErrConfiguration,
  Get,
  RouteBuilder,
  createWebApplication,
  health,
  newRouter,
  type HTTPPluginFactory,
  type NodeMiddleware,
  type WebApplication,
} from '../index.js'

/**
 * An application served under a base path, the way `UsePathBase` serves one in ASP.NET Core: the server takes the
 * base off a request's path before routing, so everything the application declares is written as if it were
 * served from the root, and a request without the base is routed as it came.
 *
 * What these guard is that a gateway forwarding `/api/...` reaches every route the application has, whoever
 * registered it, and that nothing the application declared has to change to put it there.
 */

const schema = $t.Object({
  app: $t.Object({ basePath: $t.String({ default: '/gateway' }) }, { default: {} }),
})

const kConfig = token<InferConfig<typeof schema>>(Symbol('base-path.config'))

// Module-level: `@Controller` registers into a registry every application in this file then picks up, so it
// declares a path nothing else here uses.
@Controller('/base-path-controller')
class BasePathController {
  @Get('/hello')
  hello() {
    return { source: 'controller' }
  }
}

void [BasePathController]

/** A route answering with what its handler saw of the request, so a test can tell where the base went. */
function echo(path = '/pets') {
  return newRouter().get(path, ctx => ({
    url: ctx.req.url,
    basePath: ctx.req.basePath,
    originalUrl: ctx.platform.request.originalUrl,
    x: ctx.req.query('x') ?? null,
    rawOriginalUrlSet: 'originalUrl' in ctx.req.raw,
  }))
}

/** A plugin adding a route through `$route`, as `@caffeinejs/openapi` does for its own endpoints. */
function lateRoute(): HTTPPluginFactory {
  return () => async (instance: FastifyInstance) => {
    instance.$route('late', router => {
      router.path('/late').routes([
        new RouteBuilder()
          .method('GET')
          .path('/hello')
          .handle(() => ({ source: '$route' })),
      ])
    })
  }
}

/** The status and body of a request: JSON when the response is, its text otherwise. */
async function get(app: WebApplication, url: string, init?: RequestInit) {
  const res = await app.fetch(url, init)
  const json = res.headers.get('content-type')?.includes('application/json') === true
  return { status: res.status, body: json ? await res.json() : await res.text() }
}

describe('an application under a base path', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  describe('configuration', () => {
    it('drops trailing slashes and exposes the base to plugins', async () => {
      app = createWebApplication().basePath('/api/').mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '/api' } })
      expect(app.instance.$basePath).toBe('/api')
    })

    it.each([
      ['an empty string', ''],
      ['"/"', '/'],
      ['a callback returning undefined', () => undefined],
      ['a callback returning "/"', () => '/'],
    ])('reads %s as no base path at all', async (_label, value) => {
      app = createWebApplication().basePath(value).mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '' } })
      expect(app.instance.$basePath).toBe('')
    })

    it('resolves an async callback the same as a string', async () => {
      app = createWebApplication()
        .basePath(async () => '/api')
        .mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { basePath: '/api' } })
    })

    it('hands a callback the context a plugin factory gets, typed by the configuration', async () => {
      const conf = newConfiguration(schema, kConfig).build()
      let factoryContext: unknown
      let basePathContext: unknown

      app = createWebApplication({ config: conf })
        .with(context => {
          factoryContext = context
          return async () => {}
        })
        .basePath(context => {
          basePathContext = context
          // Compiles only because the application's configuration type reaches the callback.
          return context.config.app.basePath
        })
        .mount(echo()) as WebApplication
      await app.ready()

      expect(basePathContext).toBe(factoryContext)
      expect(await get(app, '/gateway/pets')).toMatchObject({ status: 200, body: { basePath: '/gateway' } })
    })

    it.each([
      ['api', 'does not start with "/"'],
      ['/api?x', 'contains "?"'],
      ['/api#x', 'contains "#"'],
    ])('fails start-up on %s, given directly or by a callback', async (value, reason) => {
      for (const basePath of [value, () => value]) {
        const ready = createWebApplication().basePath(basePath).ready()

        await expect(ready).rejects.toThrow(ErrConfiguration)
        await expect(ready).rejects.toThrow(reason)
      }
    })

    it('fails start-up with what the callback threw, before any plugin factory has run', async () => {
      const boom = new Error('no base path today')
      let factoryRan = false

      const failing = createWebApplication()
        .with(() => {
          factoryRan = true
          return async () => {}
        })
        .basePath(() => {
          throw boom
        })

      await expect(failing.ready()).rejects.toBe(boom)
      expect(factoryRan).toBe(false)
    })

    it('is resolved after the server settings and before the plugin factories', async () => {
      const order: string[] = []

      app = createWebApplication()
        .with(() => {
          order.push('factory')
          return async () => {}
        })
        .basePath(() => {
          order.push('basePath')
          return '/api'
        })
        .server(() => {
          order.push('server')
          return {}
        })
      await app.ready()

      expect(order).toEqual(['server', 'basePath', 'factory'])
    })

    it('takes the last call', async () => {
      app = createWebApplication().basePath('/a').basePath('/b').mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/b/pets')).toMatchObject({ status: 200, body: { basePath: '/b' } })
      expect((await get(app, '/a/pets')).status).toBe(404)
    })

    it('refuses a change once the application is ready', async () => {
      app = createWebApplication()
      await app.ready()

      expect(() => app!.basePath('/api')).toThrow(ErrApplicationStarted)
    })
  })

  describe('matching a request', () => {
    it('routes a request with or without the base, telling the handler which it was', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '/api' } })
      expect(await get(app, '/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '' } })
    })

    it.each([
      ['/api', '/', null],
      ['/api/', '/', null],
      ['/api?x=1', '/?x=1', '1'],
    ])('takes %s to the root route, as %s', async (url, appURL, x) => {
      app = createWebApplication().basePath('/api').mount(echo('/')) as WebApplication
      await app.ready()

      expect(await get(app, url)).toMatchObject({ status: 200, body: { url: appURL, basePath: '/api', x } })
    })

    it('takes the base off only on a segment boundary', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()

      expect((await get(app, '/apix/pets')).status).toBe(404)
    })

    it('leaves a route that merely starts like the base to answer as declared', async () => {
      app = createWebApplication().basePath('/api').mount(echo('/apix/pets')) as WebApplication
      await app.ready()

      expect(await get(app, '/apix/pets')).toMatchObject({ status: 200, body: { url: '/apix/pets', basePath: '' } })
    })

    it('compares the base case-sensitively, as the router compares paths', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()

      expect((await get(app, '/API/pets')).status).toBe(404)
    })

    it('takes the base off once, so a route declared under the same segment is reached below it', async () => {
      app = createWebApplication().basePath('/api').mount(echo('/api/pets')) as WebApplication
      await app.ready()

      expect(await get(app, '/api/api/pets')).toMatchObject({
        status: 200,
        body: { url: '/api/pets', basePath: '/api' },
      })
      expect((await get(app, '/api/pets')).status).toBe(404)
    })

    it("answers HEAD through Fastify's automatic HEAD route", async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()

      expect((await app.fetch('/api/pets', { method: 'HEAD' })).status).toBe(200)
    })

    it('keeps the query, and the full URL as the request arrived', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/api/pets?x=1')).toMatchObject({
        status: 200,
        body: { url: '/pets?x=1', basePath: '/api', originalUrl: '/api/pets?x=1', x: '1' },
      })
    })

    it("applies the server's router options to the path left once the base is off", async () => {
      app = createWebApplication()
        .basePath('/api')
        .server(() => ({ factory: { routerOptions: { ignoreTrailingSlash: true } } }))
        .mount(echo()) as WebApplication
      await app.ready()

      expect((await get(app, '/api/pets/')).status).toBe(200)
    })

    it("runs the application's own rewriteUrl after it, on the path the application sees", async () => {
      // Fastify calls a `rewriteUrl` with the server as `this`; wrapping it must not lose that.
      const calledOnServer: boolean[] = []

      app = createWebApplication()
        .basePath('/api')
        .server(() => ({
          factory: {
            rewriteUrl(req) {
              calledOnServer.push(this === app?.instance)
              return req.url === '/old' ? '/pets' : (req.url ?? '/')
            },
          },
        }))
        .mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/api/old')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '/api' } })
      expect(await get(app, '/old')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '' } })
      expect(calledOnServer).toEqual([true, true])
    })

    it('answers a miss under the base exactly as it answers one without a base path', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()
      const plain = createWebApplication().mount(echo()) as WebApplication
      await plain.ready()

      try {
        expect(await get(app, '/api/nope')).toEqual(await get(plain, '/nope'))
      } finally {
        await plain.close()
      }
    })
  })

  describe('every source of routes', () => {
    const sources = [
      ['a decorated controller', '/base-path-controller/hello'],
      ['a mounted router', '/router/hello'],
      ['a $route group', '/late/hello'],
      ['the health probes', '/livez'],
      ['a raw route written in .serverCallback(...)', '/callback-raw'],
      ['a raw route a plugin registered', '/plugin-raw'],
    ] as const

    function everySource(): WebApplication {
      return createWebApplication()
        .basePath('/api')
        .serverCallback((_context, instance) => {
          instance.get('/callback-raw', async () => ({ source: 'serverCallback' }))
        })
        .with(lateRoute())
        .with(health())
        .with(() =>
          fp(
            async (instance: FastifyInstance) => {
              instance.get('/plugin-raw', async () => ({ source: 'plugin' }))
            },
            { name: 'base-path-raw-route' },
          ),
        )
        .mount(newRouter('/router').get('/hello', () => ({ source: 'router' }))) as WebApplication
    }

    it.each(sources)('serves %s under the base, and without it', async (_label, path) => {
      app = everySource()
      await app.ready()

      const under = await get(app, `/api${path}`)

      expect(under.status).not.toBe(404)
      expect(under).toEqual(await get(app, path))
    })
  })

  describe('redirects the application writes', () => {
    function redirecting(): WebApplication {
      return createWebApplication()
        .basePath('/api')
        .mount(
          newRouter()
            .get('/go', ctx => {
              ctx.redirect('~/done', 303)
            })
            .get('/verbatim', ctx => {
              ctx.redirect('/done')
            })
            .get('/escape', ctx => {
              ctx.redirect('~//evil.example')
            }),
        ) as WebApplication
    }

    it('resolves "~/" against the base the request came in under', async () => {
      app = redirecting()
      await app.ready()

      const under = await app.fetch('/api/go')
      expect(under.status).toBe(303)
      expect(under.headers.get('location')).toBe('/api/done')
      expect((await app.fetch('/go')).headers.get('location')).toBe('/done')
    })

    it('sends any other URL as it is written', async () => {
      app = redirecting()
      await app.ready()

      expect((await app.fetch('/api/verbatim')).headers.get('location')).toBe('/done')
    })

    it('never resolves "~//" into a URL that leaves the origin', async () => {
      app = redirecting()
      await app.ready()

      expect((await app.fetch('/api/escape')).headers.get('location')).toBe('~//evil.example')
    })
  })

  describe('what the application declared stays relative to it', () => {
    it('runs a path middleware for its path under the base, with the full URL still on the request', async () => {
      const seen: Array<{ url: string | undefined; originalUrl: string | undefined }> = []

      app = createWebApplication().basePath('/api').mount(echo('/admin/x'), echo('/other')) as WebApplication
      app.use('/admin', ((req, _res, next) => {
        seen.push({ url: req.url, originalUrl: (req as IncomingMessage & { originalUrl?: string }).originalUrl })
        next()
      }) as NodeMiddleware)
      await app.ready()

      // The handler reads the full URL after the middleware ran over the request: it must not have been replaced
      // by the path the base was taken off.
      expect(await get(app, '/api/admin/x')).toMatchObject({
        status: 200,
        body: { url: '/admin/x', originalUrl: '/api/admin/x' },
      })
      expect(seen).toEqual([{ url: '/x', originalUrl: '/api/admin/x' }])

      await get(app, '/api/other')
      expect(seen).toHaveLength(1)
    })

    it('runs a Caffeine middleware registered under a path for that path under the base', async () => {
      const seen: Array<{ basePath: string; url: string }> = []

      app = createWebApplication().basePath('/api').mount(echo('/admin/x'), echo('/other')) as WebApplication
      app.use('/admin', (ctx, next) => {
        seen.push({ basePath: ctx.req.basePath, url: ctx.req.url })
        next()
      })
      await app.ready()

      await get(app, '/api/admin/x')
      await get(app, '/api/other')

      // Mounted under `/admin`, it sees that taken off as well, the same as a Node middleware does.
      expect(seen).toEqual([{ basePath: '/api', url: '/x' }])
    })

    it('still refuses a route that takes a probe path, both being relative to the application', async () => {
      const failing = createWebApplication().basePath('/api').with(health()).mount(echo('/livez'))

      await expect(failing.ready()).rejects.toThrow(/already registered at "\/livez"/)
    })
  })

  describe('cost', () => {
    it('leaves the server without a URL rewrite when there is no base path', async () => {
      app = createWebApplication().mount(echo()) as WebApplication
      await app.ready()

      // Fastify saves `originalUrl` on the raw request only when it has a `rewriteUrl` to run.
      expect(await get(app, '/pets')).toMatchObject({ status: 200, body: { rawOriginalUrlSet: false } })
    })

    it('rewrites the URL once a base path is set', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.ready()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { rawOriginalUrlSet: true } })
    })
  })
})
