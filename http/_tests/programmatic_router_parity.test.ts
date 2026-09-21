import { CaffeineIoC, Injectable } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Catch,
  Claim,
  Context,
  ErrHTTPNotFound,
  ErrorHandler,
  Guard,
  Identity,
  Principal,
  Router,
  constraints,
  createWebApplication,
  fastifyAdapterFactory,
  version,
  type ActionResult,
  type GuardInput,
} from '../index.js'

class FakeAuthHandler extends BaseAuthenticationHandler<{}> {
  result: AuthenticateResult = AuthenticateResult.none()

  constructor() {
    super({})
  }

  async authenticate(_ctx: Context): Promise<AuthenticateResult> {
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
      container.bind(TraceGuard, t => t.toSelf())
      container.bind(DenyGuard, t => t.toSelf())

      const app = createWebApplication({ container }).mount(router)
      await app.ready()

      expect((await app.fetch('/guarded/open')).status).toBe(200)
      expect((await app.fetch('/guarded/closed')).status).toBe(403)
      expect(seen).toEqual(['get_open', 'get_closed'])

      await app.close()
    })
  })

  describe('given authorization declared on the group', () => {
    it('should protect every route under it, and let a route opt out', async () => {
      const router = new Router('/secure').authorize({})
      router.get('/private').handler(() => ({ ok: true }))
      router
        .get('/public')
        .authorize({ allowAnonymous: true })
        .handler(() => ({ ok: true }))

      const handler = new FakeAuthHandler()
      handler.result = AuthenticateResult.none()

      const builder = createWebApplication(fastifyAdapterFactory(fastify()))
      builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
      const app = builder.mount(router)
      await app.ready()

      expect((await app.fetch('/secure/private')).status).toBe(401)
      expect((await app.fetch('/secure/public')).status).toBe(200)

      handler.result = successTicket([{ type: 'sub', value: 'u1' }])
      expect((await app.fetch('/secure/private')).status).toBe(200)

      await app.close()
    })

    it('should union the roles a group and a route each require', async () => {
      const router = new Router('/roles').authorize({ roles: ['staff'] })
      router
        .get('/admin')
        .authorize({ roles: ['admin'] })
        .handler(() => ({ ok: true }))

      const handler = new FakeAuthHandler()
      const builder = createWebApplication(fastifyAdapterFactory(fastify()))
      builder.authentication(auth => auth.addStrategy('default', handler).default('default'))
      const app = builder.mount(router)
      await app.ready()

      handler.result = successTicket([{ type: 'roles', value: 'staff' }])
      expect((await app.fetch('/roles/admin')).status).toBe(403)

      handler.result = successTicket([
        { type: 'roles', value: 'staff' },
        { type: 'roles', value: 'admin' },
      ])
      expect((await app.fetch('/roles/admin')).status).toBe(200)

      await app.close()
    })
  })

  describe('given an error handler named by the group', () => {
    it('should render errors thrown by its routes', async () => {
      @Catch(ErrHTTPNotFound)
      class MissingHandler implements ErrorHandler<ErrHTTPNotFound> {
        handle(ctx: Context): ActionResult {
          return ctx.status(404).body({ handled: 'by-group' })
        }
      }

      const router = new Router('/catching').catchBy([MissingHandler])
      router.get('/missing').handler(() => {
        throw new ErrHTTPNotFound('nope')
      })

      const app = createWebApplication().mount(router)
      await app.ready()

      const res = await app.fetch('/catching/missing')
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ handled: 'by-group' })

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
      await app.ready()

      const plain = await app.fetch('/shaped/plain')
      expect(plain.headers.get('x-group')).toBe('yes')
      expect(plain.headers.get('content-type')).toContain('application/json')

      const made = await app.fetch('/shaped/made', { method: 'POST' })
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
      await app.ready()

      const res = await app.fetch('/limited/small', {
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
      await app.ready()

      expect(await (await app.fetch('/multi/both')).json()).toEqual({ method: 'GET' })
      expect(await (await app.fetch('/multi/both', { method: 'POST' })).json()).toEqual({ method: 'POST' })
      expect((await app.fetch('/multi/both', { method: 'DELETE' })).status).toBe(404)

      await app.close()
    })
  })

  describe('given a version constraint', () => {
    it('should select a programmatic route by Accept-Version exactly as a decorated one', async () => {
      const v1 = new Router('/pets').name('ParityPetsV1').with(version('1.0.0'))
      v1.get('/').handler(() => ({ v: 1 }))
      const v2 = new Router('/pets').name('ParityPetsV2').with(version('2.0.0'))
      v2.get('/').handler(() => ({ v: 2 }))

      const app = createWebApplication()
        .with(() => constraints())
        .mount(v1, v2)
      await app.ready()

      expect(await (await app.fetch('/pets', { headers: { 'accept-version': '1.x' } })).json()).toEqual({ v: 1 })
      expect(await (await app.fetch('/pets', { headers: { 'accept-version': '2.x' } })).json()).toEqual({ v: 2 })
      expect((await app.fetch('/pets')).status).toBe(404)

      await app.close()
    })
  })
})
