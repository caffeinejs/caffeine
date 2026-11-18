import { newNoopLogger } from '@caffeinejs/application/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { Controller } from '../../decorators/controller.js'
import { CSRFExempt } from '../../decorators/csrf_exempt.js'
import { Post } from '../../decorators/verbs.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { Authentication } from '../security/auth/auth.js'
import { BaseAuthenticationHandler } from '../security/auth/handler.js'
import { AuthenticateResult, AuthenticationTicket } from '../security/auth/ticket.js'
import { Claim, Identity, Principal } from '../security/identity.js'
import { authentication } from '../security/security.js'
import { csrf, type CSRFBuilder } from './csrf.js'
import { csrfExempt } from './route.js'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

const CROSS_SITE = { 'sec-fetch-site': 'cross-site' }

function routes(): Router<any, any, any, any, any> {
  return new Router()
    .post('/form')
    .handler(() => 'ok')
    .get('/page')
    .handler(() => 'ok')
    .post('/hooks/x')
    .handler(() => 'ok')
    .post('/hooks/y')
    .extend(csrfExempt(false))
    .handler(() => 'ok')
    .post('/exempt')
    .extend(csrfExempt())
    .handler(() => 'ok')
}

/** The fetch application under `csrf(configure)`, its routes mounted, started; `warn` is its logger's. */
async function protectedApp(configure?: (c: CSRFBuilder) => void) {
  const warn = vi.fn()
  const built = createWebApplication()
    .logger(b => b.use({ ...newNoopLogger(), warn }))
    .with(csrf(c => configure?.(c)))
    .mount(routes())
  app = built
  await built.bootstrap()

  return { app: built, warn }
}

function post(headers: Record<string, string> | Headers = {}): RequestInit {
  return { method: 'POST', headers }
}

describe('csrf() on the engine', () => {
  it('refuses a cross-site request with an unsafe method', async () => {
    const { app } = await protectedApp()
    const res = await app.request('/form', post(CROSS_SITE))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'ERR_CSRF_CROSS_ORIGIN' })
  })

  it('lets a same-origin request through, and one carrying neither header', async () => {
    const { app } = await protectedApp()

    expect((await app.request('/form', post({ 'sec-fetch-site': 'same-origin' }))).status).toBe(200)
    expect((await app.request('/form', post())).status).toBe(200)
  })

  it('never checks a safe method', async () => {
    const { app } = await protectedApp()

    expect((await app.request('/page', { headers: CROSS_SITE })).status).toBe(200)
  })

  it('leaves a URL no route matches to the not-found answer', async () => {
    const { app } = await protectedApp()

    expect((await app.request('/nope', post(CROSS_SITE))).status).toBe(404)
  })

  it('refuses a foreign Origin when no Sec-Fetch-Site comes', async () => {
    const { app } = await protectedApp()

    expect((await app.request('/form', post({ origin: 'https://evil.example' }))).status).toBe(403)
  })

  // No browser sends either header twice: a joined value is refused, never read as its first part.
  it('refuses a duplicated Origin or Sec-Fetch-Site', async () => {
    const { app } = await protectedApp()
    const origins = new Headers()
    origins.append('origin', 'https://localhost')
    origins.append('origin', 'https://evil.example')
    const sites = new Headers()
    sites.append('sec-fetch-site', 'same-origin')
    sites.append('sec-fetch-site', 'same-origin')

    expect((await app.request('/form', post(origins))).status).toBe(403)
    expect((await app.request('/form', post(sites))).status).toBe(403)
  })

  it('leaves a route marked exempt alone', async () => {
    const { app } = await protectedApp()

    expect((await app.request('/exempt', post(CROSS_SITE))).status).toBe(200)
  })

  // A route's own mark is the more specific word: `csrfExempt(false)` keeps it under an excluded prefix.
  it('leaves a path under exclude(...) alone, unless its route is marked protected', async () => {
    const { app } = await protectedApp(c => c.exclude('/hooks'))

    expect((await app.request('/hooks/x', post(CROSS_SITE))).status).toBe(200)
    expect((await app.request('/hooks/y', post(CROSS_SITE))).status).toBe(403)
  })

  describe('a trustOrigin(...) check', () => {
    const partner = { origin: 'https://partner.example', ...CROSS_SITE }

    it('lets through what it answers true for', async () => {
      const { app } = await protectedApp(c => c.trustOrigin(() => Promise.resolve(true)))

      expect((await app.request('/form', post(partner))).status).toBe(200)
    })

    // A check that fails must never read as one that passed.
    it('fails the request when it throws, or rejects with no error', async () => {
      const throwing = await protectedApp(c =>
        c.trustOrigin(() => {
          throw new Error('x')
        }),
      )
      expect((await throwing.app.request('/form', post(partner))).status).toBe(500)
      await throwing.app.close()

      const rejecting = await protectedApp(c => c.trustOrigin(() => Promise.reject(undefined)))
      expect((await rejecting.app.request('/form', post(partner))).status).toBe(500)
    })
  })

  describe('behind a proxy', () => {
    async function proxiedApp(trustProxy: boolean) {
      const built = createWebApplication()
        .server(() => ({ trustProxy }))
        .with(csrf())
        .mount(routes())
      app = built
      await built.bootstrap()

      return built
    }

    // A forwarding header counts only under `trustProxy`, or a client could name the host it is compared with.
    it('compares the Origin with the forwarded host only under trustProxy', async () => {
      const forwarded = post({ origin: 'https://proxied.example', 'x-forwarded-host': 'proxied.example' })

      const bare = await proxiedApp(false)
      expect((await bare.request('/form', forwarded)).status).toBe(403)
      await bare.close()

      const trusting = await proxiedApp(true)
      expect((await trusting.request('/form', forwarded)).status).toBe(200)
    })

    // Known HTTPS and an `http:` Origin is a page over plain HTTP posting to the secure site.
    it('refuses an http: Origin on a request a trusted proxy says came over HTTPS', async () => {
      const downgrade = post({ origin: 'http://localhost', 'x-forwarded-proto': 'https' })

      const bare = await proxiedApp(false)
      expect((await bare.request('/form', downgrade)).status).toBe(200)
      await bare.close()

      const trusting = await proxiedApp(true)
      expect((await trusting.request('/form', downgrade)).status).toBe(403)
    })
  })

  it('leaves a method marked @CSRFExempt() alone, and keeps @CSRFExempt(false) checked in an exempt controller', async () => {
    @Controller('/csrf-controller')
    @CSRFExempt()
    class HooksController {
      @Post('/hook')
      hook() {
        return 'ok'
      }

      @Post('/form')
      @CSRFExempt(false)
      form() {
        return 'ok'
      }
    }

    const built = createWebApplication().with(csrf())
    app = built
    await built.bootstrap()

    expect((await built.request('/csrf-controller/hook', post(CROSS_SITE))).status).toBe(200)
    expect((await built.request('/csrf-controller/form', post(CROSS_SITE))).status).toBe(403)
  })

  it('warns that it is off, and checks nothing', async () => {
    const { app, warn } = await protectedApp(c => c.enabled(false))

    expect((await app.request('/form', post(CROSS_SITE))).status).toBe(200)
    expect(warn).toHaveBeenCalledWith({ plugin: 'caffeine-csrf' }, 'Cross-origin protection is turned off')
  })

  it('logs a refusal with its reason and path, and no query', async () => {
    const { app, warn } = await protectedApp()
    await app.request('/form?token=secret', post(CROSS_SITE))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatchObject({ reason: 'sec-fetch-site', method: 'POST', path: '/form' })
    expect(warn.mock.calls[0]![1]).toBe('Cross-origin request refused')
  })

  it("covers a router's routes alone when registered on the router", async () => {
    const built = createWebApplication()
      .mount(routes())
      .mount(
        new Router('/a')
          .with(csrf())
          .post('/x')
          .handler(() => 'ok'),
      )
    app = built
    await built.bootstrap()

    expect((await built.request('/a/x', post(CROSS_SITE))).status).toBe(403)
    expect((await built.request('/form', post(CROSS_SITE))).status).toBe(200)
  })

  // Registered ahead of the gate, a cross-origin request is refused before anyone is authenticated.
  it('refuses a cross-site request before the gate authenticates it', async () => {
    class Nobody extends BaseAuthenticationHandler<object> {
      constructor() {
        super({})
      }

      async authenticate(ctx: IContext): Promise<AuthenticateResult> {
        const user = ctx.req.header('x-a')
        return user === undefined
          ? AuthenticateResult.none()
          : AuthenticateResult.success(
              new AuthenticationTicket(
                new Principal(true, [new Identity('A', true, [new Claim('sub', user, '')])]),
                'A',
              ),
            )
      }
    }

    const built = createWebApplication()
      .install(Authentication(a => a.addStrategy('A', new Nobody())))
      .with(csrf())
      .with(authentication())
      .mount(
        new Router('/p')
          .authorize({ roles: [] })
          .post('/')
          .handler(() => 'ok'),
      )
    app = built
    await built.bootstrap()

    expect((await built.request('/p', post(CROSS_SITE))).status).toBe(403)
  })
})
