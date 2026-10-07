import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  Authentication,
  AuthenticationTicket,
  Authorization,
  BaseAuthenticationHandler,
  Catch,
  Claim,
  Controller,
  CSRFExempt,
  ErrCSRFCrossOrigin,
  Identity,
  Ops,
  Post,
  Principal,
  authentication,
  bindTo,
  createWebApplication,
  csrf,
  csrfExempt,
  csrfExemptConfig,
  newRouter,
  type ActionResult,
  type Context,
  type ErrorHandler,
  type WebApplication,
} from '../../index.js'

/**
 * The `csrf()` plugin on a server: what it refuses, what it lets through, and what leaves a route out of it.
 *
 * The header sets are what a browser sends, so a vector that fails here would fail for a real page. `app.fetch`
 * arrives at `localhost`, which is what a same-origin `Origin` names.
 */

/** `fetch()` from a page this application served: what every browser since 2023 sends. */
const SAME_ORIGIN: Record<string, string> = {
  origin: 'http://localhost',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
}

/** A form on another site posting here. */
const CROSS_SITE: Record<string, string> = {
  origin: 'https://evil.example',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

/** A page on a sibling subdomain. */
const SAME_SITE: Record<string, string> = {
  origin: 'http://blog.localhost',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

/** curl's defaults, which are also what most HTTP client libraries send. */
const CURL: Record<string, string> = { accept: '*/*', 'user-agent': 'curl/8.7.1' }

/** A browser from before Fetch Metadata: an Origin and nothing else. */
const oldBrowser = (origin: string): Record<string, string> => ({ origin })

const listener = { host: '127.0.0.1', port: 0 }

const ok = () => ({ ok: true })

/** `GET` and `POST /echo`. */
const echo = () => newRouter('/echo').get('/', ok).post('/', ok)

interface Fetching {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

function post(app: Fetching, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(path, { method: 'POST', headers })
}

/** The standard envelope a refusal renders, which carries no header value. */
async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(403)

  const text = await res.text()
  expect(JSON.parse(text)).toEqual({
    statusCode: 403,
    error: 'Forbidden',
    code: 'ERR_CSRF_CROSS_ORIGIN',
    message: 'Cannot accept the request: it is cross-origin',
  })
  expect(text).not.toContain('evil.example')
}

describe('csrf()', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  async function running<A extends { run(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.run()
    return app
  }

  describe('at start-up', () => {
    it('refuses a trusted origin that is not one, naming it', async () => {
      const app = createWebApplication().with(csrf(c => c.trustedOrigins('https://admin.example/app')))
      close = () => app.close().catch(() => undefined)

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CSRF_CONFIGURATION',
        message: expect.stringContaining('"https://admin.example/app"'),
      })
    })

    it('refuses an excluded path that does not start with a slash', async () => {
      const app = createWebApplication().with(csrf(c => c.exclude('webhooks')))
      close = () => app.close().catch(() => undefined)

      await expect(app.bootstrap()).rejects.toMatchObject({
        code: 'ERR_CSRF_CONFIGURATION',
        message: expect.stringContaining('"/webhooks"'),
      })
    })

    // Two plugins on one chain would check every request twice; refused at once by name, and admitted apart.
    it('refuses a second plugin under the same name, and admits one named apart', async () => {
      const twice = createWebApplication().with(csrf()).with(csrf())
      close = () => twice.close().catch(() => undefined)

      await expect(twice.bootstrap()).rejects.toThrow(
        /Cannot register plugin "caffeine-csrf": it is already registered/,
      )

      const apart = await ready(
        createWebApplication()
          .with(csrf())
          .with(csrf(c => c.name('api'))),
      )

      expect((await post(apart, '/nothing', CROSS_SITE)).status).toBe(404)
    })
  })

  describe('on the application server', () => {
    it('lets a same-origin request through, and sets no cookie doing so', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))
      const res = await post(app, '/echo', SAME_ORIGIN)

      expect(res.status).toBe(200)
      expect(res.headers.getSetCookie()).toEqual([])
    })

    it('refuses a cross-site request with a 403 that names no origin', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))

      await expectRefused(await post(app, '/echo', CROSS_SITE))
    })

    // A sibling subdomain is where a cookie-tossing or a compromised blog lives.
    it('refuses a same-site request', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))

      expect((await post(app, '/echo', SAME_SITE)).status).toBe(403)
    })

    // Neither header is a client that is no browser, carrying no cookies of a victim: let through, as Go does.
    it('lets a request through that carries neither Sec-Fetch-Site nor Origin', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))

      expect((await post(app, '/echo', CURL)).status).toBe(200)
      expect((await post(app, '/echo')).status).toBe(200)
    })

    it('judges a browser without Fetch Metadata by its Origin against the host', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))

      expect((await post(app, '/echo', oldBrowser('http://localhost'))).status).toBe(200)
      expect((await post(app, '/echo', oldBrowser('https://evil.example'))).status).toBe(403)
      expect((await post(app, '/echo', oldBrowser('null'))).status).toBe(403)
    })

    // A safe method changes nothing, so a cross-site GET is a link, and HEAD and OPTIONS are what a browser sends
    // before a request, not the request.
    it('never refuses a safe method', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))

      expect((await app.fetch('/echo', { headers: CROSS_SITE })).status).toBe(200)
      expect((await app.fetch('/echo', { method: 'HEAD', headers: CROSS_SITE })).status).toBe(200)
      expect((await app.fetch('/echo', { method: 'OPTIONS', headers: CROSS_SITE })).status).not.toBe(403)
    })

    // A URL nothing matched is not a route: there is nothing to protect, and it answers as it always did.
    it('leaves a URL no route matched to the not-found handler', async () => {
      const app = await ready(createWebApplication().with(csrf()).mount(echo()))
      const res = await post(app, '/nothing-here', CROSS_SITE)

      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ code: 'ERR_HTTP_NOT_FOUND' })
    })

    it('lets a cross-site request through from a trusted origin, on an exact match', async () => {
      const app = await ready(
        createWebApplication()
          .with(csrf(c => c.trustedOrigins('https://admin.example')))
          .mount(echo()),
      )

      expect((await post(app, '/echo', { ...CROSS_SITE, origin: 'https://admin.example' })).status).toBe(200)
      expect((await post(app, '/echo', { ...CROSS_SITE, origin: 'https://admin.example:8443' })).status).toBe(403)
      expect((await post(app, '/echo', oldBrowser('https://admin.example'))).status).toBe(200)
    })

    it('registers nothing when turned off', async () => {
      const app = await ready(
        createWebApplication()
          .with(csrf(c => c.enabled(false)))
          .mount(echo()),
      )

      expect((await post(app, '/echo', CROSS_SITE)).status).toBe(200)
    })

    it('reads its block from the configuration tree, and lets a fluent method win over it', async () => {
      const schema = $t.Object({
        app: $t.Object({
          csrf: $t.Object({
            enabled: $t.Optional($t.Boolean()),
            trustedOrigins: $t.Optional($t.Array($t.String())),
            exclude: $t.Optional($t.Array($t.String())),
          }),
        }),
      })
      const conf = newConfiguration(schema)
        .source(new InlineConfigSource({ app: { csrf: { trustedOrigins: ['https://admin.example'] } } }))
        .build().config

      const configured = await ready(
        createWebApplication({ config: conf })
          .with(csrf((c, { config }) => c.config(config.app.csrf)))
          .mount(echo()),
      )
      expect((await post(configured, '/echo', { ...CROSS_SITE, origin: 'https://admin.example' })).status).toBe(200)
      await close?.()

      const overridden = await ready(
        createWebApplication({ config: conf })
          .with(csrf((c, { config }) => c.config(config.app.csrf).trustedOrigins('https://other.example')))
          .mount(echo()),
      )
      expect((await post(overridden, '/echo', { ...CROSS_SITE, origin: 'https://admin.example' })).status).toBe(403)
      expect((await post(overridden, '/echo', { ...CROSS_SITE, origin: 'https://other.example' })).status).toBe(200)
    })
  })

  describe('behind a proxy', () => {
    const forwarded = (origin: string, host: string): Record<string, string> => ({ origin, 'x-forwarded-host': host })

    // The host an Origin is compared with is the one the server trusts: a forwarding header counts only under
    // `trustProxy`, or a client could name the host it would like to be compared with.
    it('compares the Origin with the forwarded host only under trustProxy', async () => {
      const bare = await ready(createWebApplication().with(csrf()).mount(echo()))
      expect((await post(bare, '/echo', forwarded('https://proxied.example', 'proxied.example'))).status).toBe(403)
      await close?.()

      const trusting = await ready(
        createWebApplication()
          .server(() => ({ factory: { trustProxy: true } }))
          .with(csrf())
          .mount(echo()),
      )
      expect((await post(trusting, '/echo', forwarded('https://proxied.example', 'proxied.example'))).status).toBe(200)
    })

    // Known HTTPS and an `http:` Origin is a page over plain HTTP posting to the secure site.
    it('refuses an http: Origin on a request a trusted proxy says came over HTTPS', async () => {
      const downgrade = { origin: 'http://localhost', 'x-forwarded-proto': 'https' }

      const bare = await ready(createWebApplication().with(csrf()).mount(echo()))
      expect((await post(bare, '/echo', downgrade)).status).toBe(200)
      await close?.()

      const trusting = await ready(
        createWebApplication()
          .server(() => ({ factory: { trustProxy: true } }))
          .with(csrf())
          .mount(echo()),
      )
      expect((await post(trusting, '/echo', downgrade)).status).toBe(403)
    })

    // `HTTPS` from a proxy is HTTPS: for the downgrade rule, and for the port the scheme implies on the Host.
    it('reads the scheme a trusted proxy wrote, in any case', async () => {
      const proxied = (origin: string, host: string) => ({ origin, host, 'x-forwarded-proto': 'HTTPS' })
      const trusting = await ready(
        createWebApplication()
          .server(() => ({ factory: { trustProxy: true } }))
          .with(csrf())
          .mount(echo()),
      )

      expect((await post(trusting, '/echo', proxied('http://app.example', 'app.example'))).status).toBe(403)
      expect((await post(trusting, '/echo', proxied('https://app.example', 'app.example:443'))).status).toBe(200)
    })
  })

  describe('exemptions', () => {
    it('leaves a method marked @CSRFExempt() alone, and no other', async () => {
      @Controller('/csrf-exempt-method')
      class HooksController {
        @Post('/hook')
        @CSRFExempt()
        hook() {
          return ok()
        }

        @Post('/guarded')
        guarded() {
          return ok()
        }
      }
      void [HooksController]

      const app = await ready(createWebApplication().with(csrf()))

      expect((await post(app, '/csrf-exempt-method/hook', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/csrf-exempt-method/guarded', CROSS_SITE)).status).toBe(403)
    })

    it('leaves every method of a controller marked @CSRFExempt() alone', async () => {
      @CSRFExempt()
      @Controller('/csrf-exempt-class')
      class WebhooksController {
        @Post('/stripe')
        stripe() {
          return ok()
        }

        @Post('/github')
        github() {
          return ok()
        }
      }
      void [WebhooksController]

      const app = await ready(createWebApplication().with(csrf()))

      expect((await post(app, '/csrf-exempt-class/stripe', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/csrf-exempt-class/github', CROSS_SITE)).status).toBe(200)
    })

    it('takes csrfExempt() on a router, and csrfExempt(false) on one of its routes', async () => {
      const hooks = newRouter('/hooks')
        .with(csrfExempt())
        .post('/open', ok)
        .post('/closed')
        .with(csrfExempt(false))
        .handler(ok)

      const app = await ready(createWebApplication().with(csrf()).mount(hooks, echo()))

      expect((await post(app, '/hooks/open', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/hooks/closed', CROSS_SITE)).status).toBe(403)
      expect((await post(app, '/echo', CROSS_SITE)).status).toBe(403)
    })

    // A prefix is a run of whole segments, judged by the path a route was registered under: no spelling of a URL
    // borrows the exemption of a route it did not match.
    it('leaves the registered paths under an excluded prefix alone, and no other', async () => {
      const hooks = newRouter('/webhooks').post('/', ok).post('/:id', ok)
      const near = newRouter('/webhooksx').post('/', ok)
      const wild = newRouter('/catch').post('/*', ok)

      const app = await ready(
        createWebApplication()
          .with(csrf(c => c.exclude('/webhooks', '/catch/webhooks')))
          .mount(hooks, near, wild),
      )

      expect((await post(app, '/webhooks', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/webhooks/123', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/webhooksx', CROSS_SITE)).status).toBe(403)
      // Registered as `/catch/*`, which is not under `/catch/webhooks`.
      expect((await post(app, '/catch/webhooks', CROSS_SITE)).status).toBe(403)
    })

    it('leaves a raw route registered with csrfExemptConfig() alone, and no other', async () => {
      const raw = () =>
        fp(
          async (instance: FastifyInstance) => {
            instance.post('/raw-hook', { config: csrfExemptConfig() }, async () => ok())
            instance.post('/raw-guarded', async () => ok())
          },
          { name: 'raw-routes' },
        )

      const app = await ready(createWebApplication().with(csrf()).with(raw))

      expect((await post(app, '/raw-hook', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/raw-guarded', CROSS_SITE)).status).toBe(403)
    })
  })

  describe('with the rest of the server', () => {
    it('hands a refusal to an enrolled @Catch(ErrCSRFCrossOrigin) handler', async () => {
      @Catch(ErrCSRFCrossOrigin)
      class CrossOriginHandler implements ErrorHandler<ErrCSRFCrossOrigin> {
        handle(ctx: Context, error: ErrCSRFCrossOrigin): ActionResult {
          return ctx.status(403).body({ caught: error.reason })
        }
      }

      const app = await ready(
        createWebApplication()
          .errorHandling(e => e.globalHandlers(CrossOriginHandler))
          .with(csrf())
          .mount(echo()),
      )
      const res = await post(app, '/echo', CROSS_SITE)

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ caught: 'sec-fetch-site' })
    })

    it('logs a refusal with what decided it', async () => {
      const logged: Array<Record<string, unknown>> = []
      const logger = { level: 'warn', stream: { write: (line: string) => void logged.push(JSON.parse(line)) } }

      const app = await ready(
        createWebApplication()
          .server(() => ({ factory: { logger } }))
          .with(csrf())
          .mount(echo()),
      )
      await post(app, '/echo', CROSS_SITE)

      expect(logged.find(entry => entry.msg === 'Cross-origin request refused')).toMatchObject({
        reason: 'sec-fetch-site',
        method: 'POST',
        url: '/echo',
        origin: 'https://evil.example',
        secFetchSite: 'cross-site',
      })
    })

    class HeaderScheme extends BaseAuthenticationHandler<object> {
      constructor() {
        super({})
      }

      async authenticate(ctx: Context): Promise<AuthenticateResult> {
        const user = ctx.req.header('x-user')
        if (user === undefined) {
          return AuthenticateResult.none()
        }

        const identity = new Identity('Header', true, [new Claim('sub', user, '')])

        return AuthenticateResult.success(new AuthenticationTicket(new Principal(true, [identity]), 'Header'))
      }

      override async challenge(ctx: Context): Promise<void> {
        ctx.status(401)
      }
    }

    const gated = () =>
      createWebApplication()
        .install(Authentication(a => a.addStrategy('Header', new HeaderScheme()).default('Header')))
        .install(Authorization(z => z.requireAuthenticatedByDefault()))

    // Hooks run in the order the plugins were written: ahead of the gate, a forged request is refused before anyone
    // is authenticated; behind it, an anonymous one meets the challenge first. Both refuse it.
    it('runs where it was written among the plugins, ahead of or behind the authentication gate', async () => {
      const ahead = await ready(gated().with(csrf()).with(authentication()).mount(echo()))
      expect((await post(ahead, '/echo', CROSS_SITE)).status).toBe(403)
      expect((await post(ahead, '/echo', { ...SAME_ORIGIN, 'x-user': 'alice' })).status).toBe(200)
      await close?.()

      const behind = await ready(gated().with(authentication()).with(csrf()).mount(echo()))
      expect((await post(behind, '/echo', CROSS_SITE)).status).toBe(401)
      expect((await post(behind, '/echo', { ...CROSS_SITE, 'x-user': 'alice' })).status).toBe(403)
    })

    it('covers one route group when registered with router.plugin(...)', async () => {
      const admin = newRouter('/admin')
        .plugin(csrf(c => c.name('admin')))
        .post('/', ok)
      const open = newRouter('/open').post('/', ok)

      const app = await ready(createWebApplication().mount(admin, open))

      expect((await post(app, '/admin', CROSS_SITE)).status).toBe(403)
      expect((await post(app, '/open', CROSS_SITE)).status).toBe(200)
    })

    // A plugin covers the server it was registered on, and only that one.
    it('covers an ops server through its own o.with(csrf()), and no other server', async () => {
      const metrics = newRouter('/metrics').with(bindTo('admin')).post('/', ok)
      const api = newRouter('/api').post('/', ok)

      const app = (await running(
        createWebApplication()
          .install(Ops('admin', o => o.server(() => ({ listener })).with(csrf())))
          .server(() => ({ listener }))
          .mount(metrics, api),
      )) as WebApplication
      const ops = app.ops.get('admin')!.address!.origin

      expect((await fetch(`${ops}/metrics`, { method: 'POST', headers: CROSS_SITE })).status).toBe(403)
      expect((await fetch(`${ops}/metrics`, { method: 'POST', headers: SAME_ORIGIN })).status).toBe(200)
      expect((await fetch(`${app.address!.origin}/api`, { method: 'POST', headers: CROSS_SITE })).status).toBe(200)
    })

    // Hooks bind to every route of the server as it readies, so a route registered before the plugin is covered.
    it('covers a route registered in .serverCallback()', async () => {
      const app = await ready(
        createWebApplication()
          .serverCallback((_context, server) => {
            server.post('/early', async () => ok())
          })
          .with(csrf()),
      )

      expect((await post(app, '/early', CROSS_SITE)).status).toBe(403)
      expect((await post(app, '/early', SAME_ORIGIN)).status).toBe(200)
    })
  })
})
