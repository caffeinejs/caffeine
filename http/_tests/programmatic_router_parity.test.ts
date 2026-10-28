import { CaffeineIoC, Injectable } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Catch,
  Claim,
  IContext,
  ErrHTTPNotFound,
  ErrorHandler,
  Guard,
  Identity,
  Principal,
  Router,
  version,
  type ActionResult,
  type GuardInput,
  Authentication,
  Guards,
} from '../index.js'
import { constraints, createWebApplication, authentication } from '../platform/fastify/index.js'

class FakeAuthHandler extends BaseAuthenticationHandler<{}> {
  result: AuthenticateResult = AuthenticateResult.none()

  constructor() {
    super({})
  }

  async authenticate(_ctx: IContext): Promise<AuthenticateResult> {
    return this.result
  }
}

function successTicket(claims: Array<{ type: string; value: string }> = [], scheme = 'default'): AuthenticateResult {
  const identity = new Identity(
    scheme,
    true,
    claims.map(c => new Claim(c.type, c.value, '')),
  )
  return AuthenticateResult.success(new AuthenticationTicket(new Principal(true, [identity]), scheme))
}

describe('programmatic router parity with the decorator feature set', () => {
  describe('given guards', () => {
    it('should run a group guard and a route guard, and deny like a decorated route', async () => {
      const seen: string[] = []

      @Injectable()
      class TraceGuard implements Guard {
        guard(input: GuardInput): boolean {
          seen.push(String(input.target.handler))
          return true
        }
      }

      @Injectable()
      class DenyGuard implements Guard {
        guard(): boolean {
          return false
        }
      }

      const router = new Router('/guarded').guards([TraceGuard])
      router.get('/open').handler(() => ({ ok: true }))
      router
        .get('/closed')
        .guards([DenyGuard])
        .handler(() => ({ ok: true }))

      const container = new CaffeineIoC()

      const app = createWebApplication({ container }).mount(router)
      await app.bootstrap()

      expect((await app.request('/guarded/open')).status).toBe(200)
      expect((await app.request('/guarded/closed')).status).toBe(403)
      expect(seen).toEqual(['get_open', 'get_closed'])

      await app.close()
    })
  })

  describe('given authorization declared on the group', () => {
    it('should protect every route under it, and let a route opt out', async () => {
      const router = new Router('/secure').authorize()
      router.get('/private').handler(() => ({ ok: true }))
      router
        .get('/public')
        .authorize({ allowAnonymous: true })
        .handler(() => ({ ok: true }))

      const handler = new FakeAuthHandler()
      handler.result = AuthenticateResult.none()

      const builder = createWebApplication()
      builder
        .install(Authentication(auth => auth.addStrategy('default', handler).default('default')))
        .with(authentication())
      const app = builder.mount(router)
      await app.bootstrap()

      expect((await app.request('/secure/private')).status).toBe(401)
      expect((await app.request('/secure/public')).status).toBe(200)

      handler.result = successTicket([{ type: 'sub', value: 'u1' }])
      expect((await app.request('/secure/private')).status).toBe(200)

      await app.close()
    })

    it('should apply the default policy to a route with bare authorize()', async () => {
      const router = new Router('/secure')
      router.get('/public').handler(() => ({ ok: true }))
      router
        .get('/private')
        .authorize()
        .handler(() => ({ ok: true }))

      const handler = new FakeAuthHandler()
      const builder = createWebApplication()
      builder
        .install(Authentication(auth => auth.addStrategy('default', handler).default('default')))
        .with(authentication())
      const app = builder.mount(router)
      await app.bootstrap()

      expect((await app.request('/secure/public')).status).toBe(200)
      expect((await app.request('/secure/private')).status).toBe(401)

      handler.result = successTicket()
      expect((await app.request('/secure/private')).status).toBe(200)

      await app.close()
    })

    it('should union the roles a group and a route each require', async () => {
      const router = new Router('/roles').authorize({ roles: ['staff'] })
      router
        .get('/admin')
        .authorize({ roles: ['admin'] })
        .handler(() => ({ ok: true }))

      const handler = new FakeAuthHandler()
      const builder = createWebApplication()
      builder
        .install(Authentication(auth => auth.addStrategy('default', handler).default('default')))
        .with(authentication())
      const app = builder.mount(router)
      await app.bootstrap()

      handler.result = successTicket([{ type: 'roles', value: 'staff' }])
      expect((await app.request('/roles/admin')).status).toBe(403)

      handler.result = successTicket([
        { type: 'roles', value: 'staff' },
        { type: 'roles', value: 'admin' },
      ])
      expect((await app.request('/roles/admin')).status).toBe(200)

      await app.close()
    })
  })

  describe('given an error handler named by the group', () => {
    it('should render errors thrown by its routes', async () => {
      @Catch(ErrHTTPNotFound)
      class MissingHandler implements ErrorHandler<ErrHTTPNotFound> {
        handle(ctx: IContext): ActionResult {
          return ctx.status(404).body({ handled: 'by-group' })
        }
      }

      const router = new Router('/catching').catchBy([MissingHandler])
      router.get('/missing').handler(() => {
        throw new ErrHTTPNotFound('nope')
      })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const res = await app.request('/catching/missing')
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ handled: 'by-group' })

      await app.close()
    })

    it("should let a route's own handler win over the group's, and leave its siblings to the group's", async () => {
      @Catch(ErrHTTPNotFound)
      class GroupMissing implements ErrorHandler<ErrHTTPNotFound> {
        handle(ctx: IContext): ActionResult {
          return ctx.status(404).body({ handled: 'by-group' })
        }
      }

      @Catch(ErrHTTPNotFound)
      class RouteMissing implements ErrorHandler<ErrHTTPNotFound> {
        handle(ctx: IContext): ActionResult {
          return ctx.status(410).body({ handled: 'by-route' })
        }
      }

      const router = new Router('/catching-route').catchBy([GroupMissing])
      router
        .get('/own')
        .catchBy([RouteMissing])
        .handler(() => {
          throw new ErrHTTPNotFound('nope')
        })
      router.get('/sibling').handler(() => {
        throw new ErrHTTPNotFound('nope')
      })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const own = await app.request('/catching-route/own')
      expect(own.status).toBe(410)
      expect(await own.json()).toEqual({ handled: 'by-route' })

      const sibling = await app.request('/catching-route/sibling')
      expect(sibling.status).toBe(404)
      expect(await sibling.json()).toEqual({ handled: 'by-group' })

      await app.close()
    })
  })

  describe('given response shaping declared on a group and a route', () => {
    it('should apply status, headers and content type the way the decorators do', async () => {
      const router = new Router('/shaped').header('x-group', 'yes').produces('application/json')

      router.get('/plain').handler(() => ({ ok: true }))
      router
        .post('/made')
        .status(201)
        .header('x-route', 'yes')
        .produces('text/plain')
        .handler(() => 'created')

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const plain = await app.request('/shaped/plain')
      expect(plain.headers.get('x-group')).toBe('yes')
      expect(plain.headers.get('content-type')).toContain('application/json')

      const made = await app.request('/shaped/made', { method: 'POST' })
      expect(made.status).toBe(201)
      expect(made.headers.get('x-group')).toBe('yes')
      expect(made.headers.get('x-route')).toBe('yes')
      expect(made.headers.get('content-type')).toContain('text/plain')
      expect(await made.text()).toBe('created')

      await app.close()
    })
  })

  describe('given a body limit on a route', () => {
    it('should reject a body over it', async () => {
      const router = new Router('/limited')
      router
        .post('/small')
        .bodyLimit(16)
        .handler(ctx => ctx.body(ctx.req.body()))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const res = await app.request('/limited/small', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(64) }),
      })
      expect(res.status).toBe(413)

      await app.close()
    })
  })

  describe('given a route answering several methods', () => {
    it('should register every one of them', async () => {
      const router = new Router('/multi')
      router.route(['GET', 'POST'], '/both').handler(ctx => ({ method: ctx.req.method }))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      expect(await (await app.request('/multi/both')).json()).toEqual({ method: 'GET' })
      expect(await (await app.request('/multi/both', { method: 'POST' })).json()).toEqual({ method: 'POST' })
      expect((await app.request('/multi/both', { method: 'DELETE' })).status).toBe(404)

      await app.close()
    })

    it('should take one method as a string, in any case', async () => {
      const router = new Router('/single').route('patch', '/lower', ctx => ({ method: ctx.req.method }))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      expect(await (await app.request('/single/lower', { method: 'PATCH' })).json()).toEqual({ method: 'PATCH' })
      expect((await app.request('/single/lower')).status).toBe(404)

      await app.close()
    })
  })

  describe('given the verb helpers past the common four', () => {
    it('should answer HEAD alone on a head() route', async () => {
      // No GET on this path: Fastify gives a GET route a HEAD twin, which a head() route on the same path would meet.
      const router = new Router('/probe').head('/', ctx => {
        ctx.header('x-probe', 'yes')
        return { ok: true }
      })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const head = await app.request('/probe', { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('x-probe')).toBe('yes')
      expect((await app.request('/probe')).status).toBe(404)

      await app.close()
    })

    it('should answer OPTIONS alone on an options() route', async () => {
      const router = new Router('/opts').options('/', ctx => {
        ctx.header('allow', 'GET, OPTIONS')
        return { methods: ['GET', 'OPTIONS'] }
      })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const options = await app.request('/opts', { method: 'OPTIONS' })
      expect(options.status).toBe(200)
      expect(options.headers.get('allow')).toBe('GET, OPTIONS')
      expect((await app.request('/opts')).status).toBe(404)

      await app.close()
    })

    // all() names seven methods, not every one the adapter routes: QUERY is declared on its own.
    it('should answer the seven methods all() names, and not QUERY', async () => {
      const router = new Router('/any').all('/', ctx => ({ method: ctx.req.method }))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        expect(await (await app.request('/any', { method })).json()).toEqual({ method })
      }
      // A QUERY carries a body, and Fastify wants its content type before it finds there is no route.
      const query = await app.request('/any', {
        method: 'QUERY',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(query.status).toBe(404)

      await app.close()
    })
  })

  describe('given a body limit and a timeout on a group', () => {
    it('should hold every route to the body limit, unless a route sets its own', async () => {
      const router = new Router('/limited-group').bodyLimit(16)
      router.post('/small').handler(ctx => ctx.body(ctx.req.body()))
      router
        .post('/large')
        .bodyLimit(1024)
        .handler(ctx => ctx.body(ctx.req.body()))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const post = (path: string) =>
        app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ padding: 'x'.repeat(64) }),
        })

      expect((await post('/limited-group/small')).status).toBe(413)
      expect((await post('/limited-group/large')).status).toBe(200)

      await app.close()
    })

    it('should time every route out, unless a route sets its own', async () => {
      const slow = async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { ok: true }
      }
      const router = new Router('/timed-group').timeout(1)
      router.get('/slow').handler(slow)
      router.get('/patient').timeout(500).handler(slow)

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      expect((await app.request('/timed-group/slow')).status).toBe(503)
      expect((await app.request('/timed-group/patient')).status).toBe(200)

      await app.close()
    })
  })

  describe('given adapter configuration on a group and a route', () => {
    // What a feature reads per request, as `@Config` writes it. The more specific level wins a key outright.
    it("should give every route the group's entries, a route's own replacing the group's for its key", async () => {
      const read = (ctx: IContext) => {
        const config = ctx.routeConfig as Record<string, unknown>
        return { feature: config.feature, other: config.other }
      }
      const router = new Router('/configured').config('feature', { level: 'group' }).config('other', 'kept')
      router.get('/inherits').handler(read)
      router.get('/overrides').config('feature', { tier: 'route' }).handler(read)

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      expect(await (await app.request('/configured/inherits')).json()).toEqual({
        feature: { level: 'group' },
        other: 'kept',
      })
      expect(await (await app.request('/configured/overrides')).json()).toEqual({
        feature: { tier: 'route' },
        other: 'kept',
      })

      await app.close()
    })
  })

  describe('given media types a group and a route consume', () => {
    // Nothing refuses a request by it: it is what a reader such as the OpenAPI generator documents.
    it("should give a route the group's list unless it declares its own", async () => {
      const router = new Router('/consuming').consumes('application/json')
      router.post('/json').handler(() => ({ ok: true }))
      router
        .post('/form')
        .consumes(['application/x-www-form-urlencoded', 'multipart/form-data'])
        .handler(() => ({ ok: true }))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const group = app.routeGroups.find(candidate => candidate.path === '/consuming')!
      const accept = (path: string) => group.routes.find(route => route.path === path)!.accept
      expect(accept('/json')).toEqual(['application/json'])
      expect(accept('/form')).toEqual(['application/x-www-form-urlencoded', 'multipart/form-data'])

      await app.close()
    })
  })

  describe('given a version constraint', () => {
    it('should select a programmatic route by Accept-Version exactly as a decorated one', async () => {
      const v1 = new Router('/pets').name('ParityPetsV1').extend(version('1.0.0'))
      v1.get('/').handler(() => ({ v: 1 }))
      const v2 = new Router('/pets').name('ParityPetsV2').extend(version('2.0.0'))
      v2.get('/').handler(() => ({ v: 2 }))

      const app = createWebApplication().with(constraints()).mount(v1, v2)
      await app.bootstrap()

      expect(await (await app.request('/pets', { headers: { 'accept-version': '1.x' } })).json()).toEqual({ v: 1 })
      expect(await (await app.request('/pets', { headers: { 'accept-version': '2.x' } })).json()).toEqual({ v: 2 })
      expect((await app.request('/pets')).status).toBe(404)

      await app.close()
    })
  })
})
