import type { IncomingMessage } from 'node:http'

import { ErrApplicationStarted, newConfiguration } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { healthProbes } from '../core/health/index.js'
import {
  Controller,
  ErrConfiguration,
  Get,
  HTTPPlugin,
  Router,
  type HTTPSetupContext,
  type NodeMiddleware,
  type WebApplication,
} from '../index.js'
import { createWebApplication, newRouter } from '../platform/node/index.js'

/** A plugin that does nothing, where a factory must return one. */
class NoopPlugin extends HTTPPlugin {
  register(): void {}
}

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
    originalUrl: (u => u.pathname + u.search)(new URL(ctx.req.raw.url)),
    x: ctx.req.query('x') ?? null,
  }))
}

/** A plugin mounting a router of its own, as `@caffeinejs/openapi` does for its own endpoints. */
class LateRoute extends HTTPPlugin {
  override readonly name = 'late-route'

  register({ app }: HTTPSetupContext): void {
    app.mount(new Router('/late').get('/hello', () => ({ source: 'late' })))
  }
}

/** The status and body of a request: JSON when the response is, its text otherwise. */
async function get(app: WebApplication, url: string, init?: RequestInit) {
  const res = await app.request(url, init)
  const json = res.headers.get('content-type')?.includes('application/json') === true
  return { status: res.status, body: json ? await res.json() : await res.text() }
}

function unstamped(problem: unknown): Record<string, unknown> {
  const { correlation_id: _id, timestamp: _at, ...rest } = problem as Record<string, unknown>
  return rest
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
      await app.bootstrap()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '/api' } })
    })

    it.each([
      ['an empty string', ''],
      ['"/"', '/'],
      ['a callback returning undefined', () => undefined],
      ['a callback returning "/"', () => '/'],
    ])('reads %s as no base path at all', async (_label, value) => {
      let seen: string | undefined

      app = createWebApplication()
        .with(context => {
          seen = context.app.server?.basePath
          return new NoopPlugin()
        })
        .basePath(value)
        .mount(echo()) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '' } })
      expect(seen).toBe('')
    })

    it('resolves an async callback the same as a string', async () => {
      app = createWebApplication()
        .basePath(async () => '/api')
        .mount(echo()) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { basePath: '/api' } })
    })

    it('hands a callback the context a plugin factory gets, typed by the configuration', async () => {
      const conf = newConfiguration(schema).build().config
      let factoryContext: unknown
      let basePathContext: unknown

      app = createWebApplication({ config: conf })
        .with(context => {
          factoryContext = context
          return new NoopPlugin()
        })
        .basePath(context => {
          basePathContext = context
          // Compiles only because the application's configuration type reaches the callback.
          return context.config.app.basePath
        })
        .mount(echo()) as WebApplication
      await app.bootstrap()

      expect(basePathContext).toBe(factoryContext)
      expect(await get(app, '/gateway/pets')).toMatchObject({ status: 200, body: { basePath: '/gateway' } })
    })

    it.each([
      ['api', 'does not start with "/"'],
      ['/api?x', 'contains "?"'],
      ['/api#x', 'contains "#"'],
    ])('fails start-up on %s, given directly or by a callback', async (value, reason) => {
      for (const basePath of [value, () => value]) {
        const ready = createWebApplication().basePath(basePath).bootstrap()

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
          return new NoopPlugin()
        })
        .basePath(() => {
          throw boom
        })

      await expect(failing.bootstrap()).rejects.toBe(boom)
      expect(factoryRan).toBe(false)
    })

    it('is resolved after the server settings and before the plugin factories', async () => {
      const order: string[] = []

      app = createWebApplication()
        .with(() => {
          order.push('factory')
          return new NoopPlugin()
        })
        .basePath(() => {
          order.push('basePath')
          return '/api'
        })
        .server(() => {
          order.push('server')
          return {}
        })
      await app.bootstrap()

      expect(order).toEqual(['server', 'basePath', 'factory'])
    })

    it('takes the last call', async () => {
      app = createWebApplication().basePath('/a').basePath('/b').mount(echo()) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/b/pets')).toMatchObject({ status: 200, body: { basePath: '/b' } })
      expect((await get(app, '/a/pets')).status).toBe(404)
    })

    it('refuses a change once the application is ready', async () => {
      app = createWebApplication()
      await app.bootstrap()

      expect(() => app!.basePath('/api')).toThrow(ErrApplicationStarted)
    })
  })

  describe('matching a request', () => {
    it('routes a request with or without the base, telling the handler which it was', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/api/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '/api' } })
      expect(await get(app, '/pets')).toMatchObject({ status: 200, body: { url: '/pets', basePath: '' } })
    })

    it.each([
      ['/api', '/', null],
      ['/api/', '/', null],
      ['/api?x=1', '/?x=1', '1'],
    ])('takes %s to the root route, as %s', async (url, appURL, x) => {
      app = createWebApplication().basePath('/api').mount(echo('/')) as WebApplication
      await app.bootstrap()

      expect(await get(app, url)).toMatchObject({ status: 200, body: { url: appURL, basePath: '/api', x } })
    })

    it('takes the base off only on a segment boundary', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.bootstrap()

      expect((await get(app, '/apix/pets')).status).toBe(404)
    })

    it('leaves a route that merely starts like the base to answer as declared', async () => {
      app = createWebApplication().basePath('/api').mount(echo('/apix/pets')) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/apix/pets')).toMatchObject({ status: 200, body: { url: '/apix/pets', basePath: '' } })
    })

    it('compares the base case-sensitively, as the router compares paths', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.bootstrap()

      expect((await get(app, '/API/pets')).status).toBe(404)
    })

    it('takes the base off once, so a route declared under the same segment is reached below it', async () => {
      app = createWebApplication().basePath('/api').mount(echo('/api/pets')) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/api/api/pets')).toMatchObject({
        status: 200,
        body: { url: '/api/pets', basePath: '/api' },
      })
      expect((await get(app, '/api/pets')).status).toBe(404)
    })

    it('answers HEAD for a GET route under the base', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.bootstrap()

      expect((await app.request('/api/pets', { method: 'HEAD' })).status).toBe(200)
    })

    it('keeps the query, and the full URL as the request arrived', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.bootstrap()

      expect(await get(app, '/api/pets?x=1')).toMatchObject({
        status: 200,
        body: { url: '/pets?x=1', basePath: '/api', originalUrl: '/api/pets?x=1', x: '1' },
      })
    })

    it("applies the server's router options to the path left once the base is off", async () => {
      app = createWebApplication()
        .basePath('/api')
        .server(() => ({ router: { ignoreTrailingSlash: true } }))
        .mount(echo()) as WebApplication
      await app.bootstrap()

      expect((await get(app, '/api/pets/')).status).toBe(200)
    })

    it('answers a miss under the base exactly as it answers one without a base path', async () => {
      app = createWebApplication().basePath('/api').mount(echo()) as WebApplication
      await app.bootstrap()
      const plain = createWebApplication().mount(echo()) as WebApplication
      await plain.bootstrap()

      try {
        // Each answer carries its own request ID and time; the rest is the same.
        const miss = await get(app, '/api/nope')
        const plainMiss = await get(plain, '/nope')
        expect({ ...miss, body: unstamped(miss.body) }).toEqual({ ...plainMiss, body: unstamped(plainMiss.body) })
      } finally {
        await plain.close()
      }
    })
  })

  describe('every source of routes', () => {
    const sources = [
      ['a decorated controller', '/base-path-controller/hello'],
      ['a mounted router', '/router/hello'],
      ['a router mounted by a plugin', '/late/hello'],
      ['the health probes', '/livez'],
    ] as const

    function everySource(): WebApplication {
      return createWebApplication()
        .basePath('/api')
        .with(() => new LateRoute())
        .with(healthProbes())
        .mount(newRouter('/router').get('/hello', () => ({ source: 'router' }))) as WebApplication
    }

    it.each(sources)('serves %s under the base, and without it', async (_label, path) => {
      app = everySource()
      await app.bootstrap()

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
      await app.bootstrap()

      const under = await app.request('/api/go')
      expect(under.status).toBe(303)
      expect(under.headers.get('location')).toBe('/api/done')
      expect((await app.request('/go')).headers.get('location')).toBe('/done')
    })

    it('sends any other URL as it is written', async () => {
      app = redirecting()
      await app.bootstrap()

      expect((await app.request('/api/verbatim')).headers.get('location')).toBe('/done')
    })

    it('never resolves "~//" into a URL that leaves the origin', async () => {
      app = redirecting()
      await app.bootstrap()

      expect((await app.request('/api/escape')).headers.get('location')).toBe('~//evil.example')
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
      await app.bootstrap()

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
      await app.bootstrap()

      await get(app, '/api/admin/x')
      await get(app, '/api/other')

      // Mounted under `/admin`, it sees that taken off as well, the same as a Node middleware does.
      expect(seen).toEqual([{ basePath: '/api', url: '/x' }])
    })

    it('still refuses a route that takes a probe path, both being relative to the application', async () => {
      const failing = createWebApplication().basePath('/api').with(healthProbes()).mount(echo('/livez'))

      await expect(failing.bootstrap()).rejects.toThrow(/already registered at "\/livez"/)
    })
  })
})
