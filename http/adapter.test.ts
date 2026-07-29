import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import FastifyCookie from '@fastify/cookie'
import { CaffeineIoC, Scopes, Injectable, Lifetime } from '@caffeinejs/di'
import { address, context, cookie, header, method, param, path, pick, port, query, signal, signedCookie, url } from './route_picker.js'
import { Feats } from './feats.js'
import { Controller, Get, Method, createWebApplication, Params, fastifyAdapterFactory, FastifyAdapter, FastifyContext, type AdapterFactoryIn } from './index.js'

function makeKit(): AdapterFactoryIn {
  return {
    container: new CaffeineIoC(),
  }
}

describe('Fastify Adapter', () => {
  it('exposes the underlying server as a Supertest-compatible listener', async () => {
    const app = Fastify()
    app.get('/', () => ({ ok: true }))

    const adapter = new FastifyAdapter(makeKit(), app)
    await adapter.setup({
      routers: [],
      feats: new Feats(),
      services: {
        auth: { enabled: false, coordinator: undefined, options: undefined },
        authz: { enabled: false },
      },
    })

    expect(adapter.instance).toBe(app)
    await supertest(adapter.instance.server).get('/')
      .expect(200, { ok: true })
  })

  it('exposes the underlying fastify instance and can be tested with .inject()', async () => {
    const app = Fastify()
    app.get('/', () => ({ ok: true }))

    const adapter = new FastifyAdapter(makeKit(), app)
    await adapter.setup({
      routers: [],
      feats: new Feats(),
      services: {
        auth: { enabled: false, coordinator: undefined, options: undefined },
        authz: { enabled: false },
      },
    })
    const result = await adapter.instance.inject('/')

    expect(result.json()).toEqual({ ok: true })
  })

  describe('when a controller is decorated with @Get', () => {
    it('should register the route in the fastify instance', async () => {
      @Controller('/users')
      class TestController {
        @Get('/:id')
        @Params([param('id'), query('filter'), header('x-test')])
        async get(id: string, filter: string, test: string) {
          return { ok: true, id, filter, test }
        }
      }

      void [TestController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      await supertest(app.instance.server)
        .get('/users/1?filter=test')
        .set('x-test', 'test')
        .expect(200, { ok: true, id: '1', filter: 'test', test: 'test' })
    })
  })

  describe('Parameter Pickers', () => {
    it('injects parameters into the handler based on the configured pickers', async () => {
      @Controller('/test')
      class PickersController {
        @Get('/pickers')
        @Params([url(), path(), signal(), port(), address()])
        get(
          u: string,
          p: string,
          sig: AbortSignal,
          po: number | null,
          addr: string | undefined,
        ) {
          return {
            url: u,
            path: p,
            hasSignal: sig instanceof AbortSignal,
            port: po,
            address: addr,
          }
        }
      }

      void [PickersController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/test/pickers?foo=bar' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        url: '/test/pickers?foo=bar',
        path: '/test/pickers',
        hasSignal: true,
        port: expect.any(Number),
        address: expect.any(String),
      })
    })

    it('resolves an async custom picker before calling the handler', async () => {
      @Controller('/async-pick')
      class AsyncPickController {
        @Get('/value')
        @Params([pick(req => Promise.resolve((req as { url: string }).url.toUpperCase()), { async: true })])
        get(uppercased: string) {
          return { value: uppercased }
        }
      }

      void [AsyncPickController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/async-pick/value' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ value: '/ASYNC-PICK/VALUE' })
    })

    it('resolves mixed sync and async pickers on the same route', async () => {
      @Controller('/mixed-pick')
      class MixedPickController {
        @Get('/:id')
        @Params([
          param('id'),
          pick(req => Promise.resolve(`async:${(req as { url: string }).url}`), { async: true }),
        ])
        get(id: string, asyncVal: string) {
          return { id, asyncVal }
        }
      }

      void [MixedPickController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/mixed-pick/42' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: '42', asyncVal: 'async:/mixed-pick/42' })
    })

    it('injects the HTTP method string into the handler', async () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const

      @Controller('/method-test')
      class MethodController {
        @Method([...methods])
        @Get('/action')
        @Params([method()])
        action(m: string) {
          return { method: m }
        }
      }

      void [MethodController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      for (const m of methods) {
        const res = await app.instance.inject({ method: m, url: '/method-test/action' })
        expect(res.json()).toEqual({ method: m })
      }
    })
  })

  describe('Mixing Scopes', () => {
    it('creates a new controller instance per request when request-scoped', async () => {
      let instanceCounter = 0

      @Lifetime(Scopes.REQUEST)
      @Controller('/req-ctrl')
      class RequestScopedController {
        readonly id = ++instanceCounter

        @Get('/id')
        get() {
          return { id: this.id }
        }
      }

      void [RequestScopedController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const r1 = await app.instance.inject({ method: 'GET', url: '/req-ctrl/id' })
      const r2 = await app.instance.inject({ method: 'GET', url: '/req-ctrl/id' })

      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)
      expect(r1.json().id).toBe(1)
      expect(r2.json().id).toBe(2)
    })

    it('gives a fresh request-scoped service instance per request when injected into a transient controller', async () => {
      let serviceCounter = 0

      @Lifetime(Scopes.REQUEST)
      @Injectable()
      class RequestScopedService {
        readonly id = ++serviceCounter
      }

      @Lifetime(Scopes.TRANSIENT)
      @Controller('/transient-ctrl', [RequestScopedService])
      class TransientController {
        constructor(private readonly svc: RequestScopedService) { }

        @Get('/svc-id')
        get() {
          return { id: this.svc.id }
        }
      }

      void [TransientController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const r1 = await app.instance.inject({ method: 'GET', url: '/transient-ctrl/svc-id' })
      const r2 = await app.instance.inject({ method: 'GET', url: '/transient-ctrl/svc-id' })

      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)
      expect(r1.json().id).toBe(1)
      expect(r2.json().id).toBe(2)
    })
  })

  describe('Cookies', () => {
    it('injects a named cookie via cookie() picker', async () => {
      @Controller('/ck')
      class NamedCookieController {
        @Get('/session')
        @Params([cookie('session')])
        get(session: string | undefined) {
          return { session }
        }
      }
      void [NamedCookieController]

      const fastify = Fastify()
      fastify.register(FastifyCookie)

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/session', { headers: { Cookie: 'session=abc123' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ session: 'abc123' })
    })

    it('injects all cookies via cookie() picker without a name', async () => {
      @Controller('/ck')
      class AllCookiesController {
        @Get('/all')
        @Params([cookie()])
        get(cookies: Record<string, string | undefined>) {
          return cookies
        }
      }
      void [AllCookiesController]

      const fastify = Fastify()
      fastify.register(FastifyCookie)

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/all', { headers: { Cookie: 'a=1; b=2' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ a: '1', b: '2' })
    })

    it('injects a signed cookie via signedCookie() picker', async () => {
      const SECRET = 'test-secret'
      const { sign } = await import('@fastify/cookie')
      const signed = sign('myvalue', SECRET)

      @Controller('/ck')
      class SignedController {
        @Get('/signed')
        @Params([signedCookie('tok')])
        get(tok: string | false | undefined) {
          return { tok }
        }
      }
      void [SignedController]

      const fastify = Fastify()
      fastify.register(FastifyCookie, { secret: SECRET })

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/signed', { headers: { Cookie: `tok=${signed}` } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ tok: 'myvalue' })
    })

    it('returns false for a tampered signed cookie via signedCookie() picker', async () => {
      @Controller('/ck')
      class TamperedController {
        @Get('/tampered')
        @Params([signedCookie('tok')])
        get(tok: string | false | undefined) {
          return { valid: tok !== false }
        }
      }
      void [TamperedController]

      const fastify = Fastify()
      fastify.register(FastifyCookie, { secret: 'test-secret' })

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/tampered', { headers: { Cookie: 'tok=badvalue.invalidsig' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ valid: false })
    })

    it('setCookie helper sets a Set-Cookie header on the response', async () => {
      @Controller('/ck')
      class SetCookieController {
        @Get('/set')
        @Params([context()])
        get(ctx: FastifyContext) {
          ctx.cookie('session', 'hello', { httpOnly: true, path: '/' })
          return { ok: true }
        }
      }
      void [SetCookieController]

      const fastify = Fastify()
      fastify.register(FastifyCookie)

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/set')
      expect(res.status).toBe(200)
      const setCookieHeader = res.headers.get('set-cookie')
      expect(setCookieHeader).toMatch(/session=hello/)
      expect(setCookieHeader).toMatch(/HttpOnly/)
    })

    it('getCookie helper reads a cookie from the request via context', async () => {
      @Controller('/ck')
      class GetCookieController {
        @Get('/get')
        @Params([context()])
        get(ctx: FastifyContext) {
          return { value: ctx.req.cookie('token') }
        }
      }
      void [GetCookieController]

      const fastify = Fastify()
      fastify.register(FastifyCookie)

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/get', { headers: { Cookie: 'token=secret' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ value: 'secret' })
    })

    it('ctx.req.signedCookie() reads a signed cookie from the request', async () => {
      const SECRET = 'req-signed-secret'
      const { sign } = await import('@fastify/cookie')
      const signed = sign('reqvalue', SECRET)

      @Controller('/ck')
      class ReqSignedCookieController {
        @Get('/read')
        @Params([context()])
        read(ctx: FastifyContext) {
          return { value: ctx.req.signedCookie('tok') }
        }
      }
      void [ReqSignedCookieController]

      const fastify = Fastify()
      fastify.register(FastifyCookie, { secret: SECRET })

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/read', { headers: { Cookie: `tok=${signed}` } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ value: 'reqvalue' })
    })

    it('deleteCookie helper clears a cookie', async () => {
      @Controller('/ck')
      class DeleteCookieController {
        @Get('/delete')
        @Params([context()])
        get(ctx: FastifyContext) {
          ctx.deleteCookie('session')
          return { ok: true }
        }
      }
      void [DeleteCookieController]

      const fastify = Fastify()
      fastify.register(FastifyCookie)

      const app = createWebApplication(fastifyAdapterFactory(fastify)).build()
      await app.ready()

      const res = await app.fetch('/ck/delete')
      expect(res.status).toBe(200)
      const setCookieHeader = res.headers.get('set-cookie')
      expect(setCookieHeader).toMatch(/session=/)
      expect(setCookieHeader).toMatch(/Max-Age=0/)
    })
  })
})
