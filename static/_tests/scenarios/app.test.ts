import { fileURLToPath } from 'node:url'

import {
  Args,
  AuthenticationService,
  AuthenticationTicket,
  Controller,
  ErrHTTPNotFound,
  Get,
  Post,
  createWebApplication,
  health,
  newRouter,
  $p,
  type Context,
  type WebApplication,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { immutableAssets, isDocumentRequest, sendFile, spaMount, staticFiles } from '../../index.js'
import { CURL, NAVIGATION, PROBE, SCRIPT, XHR, expectNotFoundJSON, principal, sessionCookie } from './_headers.js'

const DIST = fileURLToPath(new URL('../_testdata/spa', import.meta.url))
const SECRET = 'app-scenario-session-secret-of-at-least-32-bytes'

// Declared at module scope: the container snapshots the controller registry when it is constructed.
@Controller('/api/pets')
class PetsController {
  @Get('/')
  list(): unknown {
    return { pets: [] }
  }

  @Get('/:id')
  @Args(p => [p.param('id')])
  byID(id: string): unknown {
    return { id }
  }
}

@Controller('/api/orders')
class OrdersController {
  @Get('/')
  list(): unknown {
    return { orders: [] }
  }
}

@Controller('/api/users')
class UsersController {
  @Get('/me')
  @Args([$p.context()])
  me(ctx: Context): unknown {
    return { sub: ctx.user.findFirst('sub')?.value }
  }
}

void [PetsController, OrdersController, UsersController]

// ── everything the single-page application adds ─────────────────────────────────────────────────────────
const shellDocument = (ctx: Context) => sendFile(ctx, 'index.html')
const notFound = (ctx: Context): never => {
  throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
}
// A path the application declared answers any client; a wildcard is a fallback, so it answers only a
// document request and a missing asset stays a 404.
const clientRoute = (ctx: Context) => (isDocumentRequest(ctx) ? shellDocument(ctx) : notFound(ctx))

const publicPages = () =>
  newRouter()
    .detail('http', { internal: true })
    .authorize({ allowAnonymous: true })
    .get('/', shellDocument)
    .get('/index.html', shellDocument)
    .get('/login', shellDocument)
    .get('/about', shellDocument)
    .get('/*', clientRoute)

const memberPages = () =>
  newRouter()
    .detail('http', { internal: true })
    .authorize({})
    .get('/dashboard', shellDocument)
    .get('/dashboard/*', clientRoute)
    .get('/settings', shellDocument)
    .get('/settings/*', clientRoute)
    .get('/orders', shellDocument)
    .get('/orders/*', clientRoute)

const adminPages = () =>
  newRouter()
    .detail('http', { internal: true })
    .authorize({ roles: ['admin'] })
    .get('/admin', shellDocument)
    .get('/admin/*', clientRoute)

// One catch-all, whatever the controller count: three controllers share the base `/api`.
const apiMisses = () => newRouter('/api').get('/*', notFound)

const auth = () =>
  newRouter('/auth')
    .authorize({ allowAnonymous: true })
    .inject({ service: AuthenticationService })
    .post('/login', async (ctx, { service }) => {
      const roles = ctx.req.header('x-roles')?.split(',').filter(Boolean) ?? []
      await service.persist(ctx, 'Cookie', new AuthenticationTicket(principal('alice', roles, 'Cookie'), 'Cookie'))

      return { ok: true }
    })

function application(): WebApplication {
  return createWebApplication({})
    .with(health())
    .with(staticFiles(s => s.serve(DIST, { ...spaMount(), setHeaders: immutableAssets(DIST) }, { anonymous: true })))
    .authentication(a => a.addCookie(o => o.sessionSecret(SECRET).secure(false).loginPath('/login')))
    .authorization(z => z.requireAuthenticatedByDefault())
    .mount(auth(), apiMisses(), publicPages(), memberPages(), adminPages()) as WebApplication
}

describe('a realistic application: controllers, a router, health and a single-page application', () => {
  let app: WebApplication
  let member: string
  let admin: string

  beforeAll(async () => {
    app = application()
    await app.ready()

    const asMember = await app.fetch('/auth/login', { method: 'POST' })
    expect(asMember.status).toBe(200)
    member = sessionCookie(asMember)

    const asAdmin = await app.fetch('/auth/login', { method: 'POST', headers: { 'x-roles': 'admin' } })
    admin = sessionCookie(asAdmin)
  })

  afterAll(async () => await app.close())

  describe('the API, untouched by the single-page application', () => {
    it('routes every controller', async () => {
      for (const path of ['/api/pets', '/api/pets/7', '/api/orders', '/api/users/me']) {
        const res = await app.fetch(path, { headers: { ...XHR, cookie: member } })
        expect(res.status, path).toBe(200)
      }
    })

    // One `apiMisses` line covers three controllers and every future one.
    it('keeps an API miss a JSON 404 for a navigation as much as for a fetch', async () => {
      for (const path of ['/api/typo', '/api/pets/1/2/3']) {
        await expectNotFoundJSON(await app.fetch(path, { headers: { ...NAVIGATION, cookie: member } }))
        await expectNotFoundJSON(await app.fetch(path, { headers: { ...XHR, cookie: member } }))
      }
    })

    it('gates the controllers under the fallback policy', async () => {
      expect((await app.fetch('/api/pets', { headers: XHR })).status).toBe(401)
    })

    it('leaves the health probes to the health plugin', async () => {
      const res = await app.fetch('/livez', { headers: PROBE })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    })
  })

  describe('public client routes', () => {
    it('serves the shell anonymously, under authenticate-by-default', async () => {
      for (const path of ['/', '/index.html', '/about', '/pricing']) {
        const res = await app.fetch(path, { headers: NAVIGATION })
        expect(res.status, path).toBe(200)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    // Gating the sign-in page would redirect it to itself.
    it('serves the sign-in page anonymously and does not redirect', async () => {
      const res = await app.fetch('/login', { headers: NAVIGATION })
      expect(res.status).toBe(200)
    })

    // A path the application declared answers any client, which is what a load balancer probe needs.
    it('answers a declared path to a client that is not a browser', async () => {
      for (const headers of [CURL, PROBE]) {
        expect((await app.fetch('/', { headers })).status).toBe(200)
        expect((await app.fetch('/index.html', { headers })).status).toBe(200)
      }
    })

    it('does not answer a wildcard client route to a client that is not a browser', async () => {
      await expectNotFoundJSON(await app.fetch('/pricing', { headers: CURL }))
    })
  })

  describe('protected client routes', () => {
    it('redirects an anonymous navigation to the sign-in page, carrying the return path', async () => {
      const res = await app.fetch('/dashboard', { headers: NAVIGATION })

      expect(res.status).toBe(302)
      const location = res.headers.get('location') ?? ''
      expect(location.startsWith('/login?returnUrl=')).toBe(true)
      expect(decodeURIComponent(location)).toContain('/dashboard')
    })

    it('answers an anonymous fetch of a protected route with 401, never a document', async () => {
      const res = await app.fetch('/dashboard', { headers: XHR })

      expect(res.status).toBe(401)
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
    })

    // Authorization runs before the handler's document decision.
    it('redirects an anonymous navigation deep inside a protected subtree', async () => {
      expect((await app.fetch('/dashboard/deep', { headers: NAVIGATION })).status).toBe(302)
    })

    it('serves the shell to a signed-in member, across a subtree', async () => {
      for (const path of ['/dashboard', '/settings/profile', '/orders/42']) {
        const res = await app.fetch(path, { headers: { ...NAVIGATION, cookie: member } })
        expect(res.status, path).toBe(200)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    it('keeps the declared-versus-wildcard rule inside a protected tier', async () => {
      expect((await app.fetch('/dashboard', { headers: { ...CURL, cookie: member } })).status).toBe(200)
      await expectNotFoundJSON(await app.fetch('/dashboard/deep', { headers: { ...CURL, cookie: member } }))
    })

    it('refuses a role-gated page to a signed-in member, as an error and not as the page', async () => {
      for (const path of ['/admin', '/admin/users']) {
        const res = await app.fetch(path, { headers: { ...NAVIGATION, cookie: member } })
        expect(res.status, path).toBe(403)
        expect(res.headers.get('content-type') ?? '', path).not.toMatch(/text\/html/)
      }
    })

    it('serves the role-gated pages to an administrator', async () => {
      for (const path of ['/admin', '/admin/users']) {
        const res = await app.fetch(path, { headers: { ...NAVIGATION, cookie: admin } })
        expect(res.status, path).toBe(200)
        expect(await res.text(), path).toContain('<div id="root">')
      }
    })

    // It matches `/*`, not `/dashboard`: an unknown client route is not a protected one.
    it('answers an unknown route near a protected one with the public shell', async () => {
      const res = await app.fetch('/dashboard-typo', { headers: NAVIGATION })
      expect(res.status).toBe(200)
    })

    it('never answers a non-GET with a document', async () => {
      await expectNotFoundJSON(await app.fetch('/dashboard', { method: 'POST', headers: NAVIGATION }))
    })
  })

  describe('assets', () => {
    // One bundle serves the public and the protected routes alike, and the sign-in page needs it.
    it('serves the bundle anonymously even though client routes are gated', async () => {
      const res = await app.fetch('/assets/app-eZr2sdaR.js', { headers: SCRIPT })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    it('keeps a missing asset a JSON 404 rather than a page', async () => {
      await expectNotFoundJSON(await app.fetch('/assets/missing.js', { headers: NAVIGATION }))
    })
  })
})
