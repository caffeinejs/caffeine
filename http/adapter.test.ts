import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import FastifyCookie from '@fastify/cookie'
import { Scopes, Injectable, Lifetime } from '@caffeinejs/di'
import { $p } from './route_picker.js'
import { Controller, Get, Method, createWebApplication, Args, fastifyAdapterFactory, FastifyContext } from './index.js'

describe('Fastify Adapter', () => {
  // Binds a real ephemeral socket (unlike the app.fetch() tests below), so it can hang up under
  // parallel-suite port/event-loop contention. Retry keeps the real-socket smoke test without making it
  // flaky.
  it('binds a real listener and serves it over the network', { retry: 2 }, async () => {
    const server = Fastify()
    server.get('/', () => ({ ok: true }))

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.run()

    try {
      expect(app.instance).toBe(server)
      expect(app.address!.port).toBeGreaterThan(0)

      // Native fetch, not app.fetch(): the point is that traffic reaches the process through a socket.
      const res = await fetch(`${app.address!.origin}/`)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.close()
    }
  })

  it('exposes the underlying fastify instance and can be tested with app.fetch()', async () => {
    const server = Fastify()
    server.get('/', () => ({ ok: true }))

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const result = await app.fetch('/')

    expect(await result.json()).toEqual({ ok: true })
  })

  describe('when a controller is decorated with @Get', () => {
    it('should register the route in the fastify instance', async () => {
      @Controller('/users')
      class TestController {
        @Get('/:id')
        @Args([$p.param('id'), $p.query('filter'), $p.header('x-test')])
        async get(id: string, filter: string, test: string) {
          return { ok: true, id, filter, test }
        }
      }

      void [TestController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const res = await app.fetch('/users/1?filter=test', { headers: { 'x-test': 'test' } })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, id: '1', filter: 'test', test: 'test' })
    })
  })

  describe('Parameter Pickers', () => {
    it('injects parameters into the handler based on the configured pickers', async () => {
      @Controller('/test')
      class PickersController {
        @Get('/pickers')
        @Args([$p.url(), $p.path(), $p.signal(), $p.port(), $p.address()])
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

      const res = await app.fetch('/test/pickers?foo=bar')

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
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
        @Args([$p.pick(req => Promise.resolve((req as { url: string }).url.toUpperCase()), { async: true })])
        get(uppercased: string) {
          return { value: uppercased }
        }
      }

      void [AsyncPickController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const res = await app.fetch('/async-pick/value')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ value: '/ASYNC-PICK/VALUE' })
    })

    it('resolves mixed sync and async pickers on the same route', async () => {
      @Controller('/mixed-pick')
      class MixedPickController {
        @Get('/:id')
        @Args([
          $p.param('id'),
          $p.pick(req => Promise.resolve(`async:${(req as { url: string }).url}`), { async: true }),
        ])
        get(id: string, asyncVal: string) {
          return { id, asyncVal }
        }
      }

      void [MixedPickController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      const res = await app.fetch('/mixed-pick/42')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ id: '42', asyncVal: 'async:/mixed-pick/42' })
    })

    it('injects the HTTP method string into the handler', async () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const

      @Controller('/method-test')
      class MethodController {
        @Method([...methods])
        @Get('/action')
        @Args([$p.method()])
        action(m: string) {
          return { method: m }
        }
      }

      void [MethodController]

      const app = createWebApplication(fastifyAdapterFactory(Fastify())).build()
      await app.ready()

      for (const m of methods) {
        const res = await app.fetch('/method-test/action', { method: m })
        expect(await res.json()).toEqual({ method: m })
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

      const r1 = await app.fetch('/req-ctrl/id')
      const r2 = await app.fetch('/req-ctrl/id')

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect(await r1.json()).toEqual({ id: 1 })
      expect(await r2.json()).toEqual({ id: 2 })
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

      const r1 = await app.fetch('/transient-ctrl/svc-id')
      const r2 = await app.fetch('/transient-ctrl/svc-id')

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect(await r1.json()).toEqual({ id: 1 })
      expect(await r2.json()).toEqual({ id: 2 })
    })
  })

  describe('Cookies', () => {
    it('injects a named cookie via cookie() picker', async () => {
      @Controller('/ck')
      class NamedCookieController {
        @Get('/session')
        @Args([$p.cookie('session')])
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
        @Args([$p.cookie()])
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
        @Args([$p.signedCookie('tok')])
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
        @Args([$p.signedCookie('tok')])
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
        @Args([$p.context()])
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
        @Args([$p.context()])
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
        @Args([$p.context()])
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
        @Args([$p.context()])
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
