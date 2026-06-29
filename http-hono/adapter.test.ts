import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { address, context, Controller, cookie, Get, header, Method, method, newHTTP, Params, param, path, pick, port, query, signal, signedCookie, url } from '@caffeinejs/http'
import { CaffeineIoC, Scopes, Injectable, Lifetime } from '@caffeinejs/core'
import { HonoAdapter } from './adapter.js'
import { honoAdapterFactory } from './adapter_factory.js'
import { HonoContext } from './context.js'

describe('Hono Adapter', () => {
  it('exposes the underlying server instance', async () => {
    const app = new Hono()
    app.get('/', c => c.json({ ok: true }))

    const adapter = new HonoAdapter(new CaffeineIoC(), app)
    await adapter.setup({ routers: [] })

    expect(adapter.instance).toBe(app)
    const res = await adapter.fetch('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('can be tested with fetch()', async () => {
    const app = new Hono()
    app.get('/', c => c.json({ ok: true }))

    const adapter = new HonoAdapter(new CaffeineIoC(), app)
    await adapter.setup({ routers: [] })
    const res = await adapter.fetch('/')

    expect(await res.json()).toEqual({ ok: true })
  })

  describe('when a controller is decorated with @Get', () => {
    it('should register the route in the hono instance', async () => {
      @Controller('/users')
      class TestController {
        @Get('/:id')
        @Params([param('id'), query('filter'), header('x-test')])
        async get(id: string, filter: string, test: string) {
          return { ok: true, id, filter, test }
        }
      }

      void [TestController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()

      const res = await app.fetch('/users/1?filter=test', {
        headers: { 'x-test': 'test' },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, id: '1', filter: 'test', test: 'test' })
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

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()

      const res = await app.fetch('/test/pickers?foo=bar')

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        url: expect.stringContaining('/test/pickers'),
        path: '/test/pickers',
        hasSignal: true,
      })
    })

    it('resolves an async custom picker before calling the handler', async () => {
      @Controller('/async-pick')
      class AsyncPickController {
        @Get('/value')
        @Params([pick(c => Promise.resolve((c as { req: { url: string } }).req.url.toUpperCase()), { async: true })])
        get(uppercased: string) {
          return { value: uppercased }
        }
      }

      void [AsyncPickController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()

      const res = await app.fetch('/async-pick/value')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ value: expect.stringContaining('/ASYNC-PICK/VALUE') })
    })

    it('resolves mixed sync and async pickers on the same route', async () => {
      @Controller('/mixed-pick')
      class MixedPickController {
        @Get('/:id')
        @Params([
          param('id'),
          pick(c => Promise.resolve(`async:${(c as { req: { url: string } }).req.url}`), { async: true }),
        ])
        get(id: string, asyncVal: string) {
          return { id, asyncVal }
        }
      }

      void [MixedPickController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()

      const res = await app.fetch('/mixed-pick/42')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ id: '42', asyncVal: expect.stringContaining('async:') })
    })

    it('injects the HTTP method string into the handler', async () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const

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

      const app = newHTTP(honoAdapterFactory(new Hono()))
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

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()

      const r1 = await app.fetch('/req-ctrl/id')
      const r2 = await app.fetch('/req-ctrl/id')

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect((await r1.json() as { id: number }).id).toBe(1)
      expect((await r2.json() as { id: number }).id).toBe(2)
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
        constructor(private readonly svc: RequestScopedService) {}

        @Get('/svc-id')
        get() {
          return { id: this.svc.id }
        }
      }

      void [TransientController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()

      const r1 = await app.fetch('/transient-ctrl/svc-id')
      const r2 = await app.fetch('/transient-ctrl/svc-id')

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect((await r1.json() as { id: number }).id).toBe(1)
      expect((await r2.json() as { id: number }).id).toBe(2)
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

      const app = newHTTP(honoAdapterFactory(new Hono()))
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
        get(cookies: Record<string, string>) {
          return cookies
        }
      }
      void [AllCookiesController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/ck/all', { headers: { Cookie: 'a=1; b=2' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ a: '1', b: '2' })
    })

    it('injects a signed cookie via signedCookie() picker', async () => {
      const SECRET = 'signed-picker-secret'

      @Controller('/ck-sp')
      class SignedPickerController {
        @Get('/set')
        @Params([context()])
        async set(ctx: HonoContext) {
          await ctx.signedCookie('tok', 'myvalue')
          return null
        }

        @Get('/get')
        @Params([signedCookie('tok')])
        read(tok: string | false | undefined) {
          return { tok }
        }
      }
      void [SignedPickerController]

      const app = newHTTP(honoAdapterFactory(new Hono(), { cookies: { secret: SECRET } }))
      await app.ready()

      const setRes = await app.fetch('/ck-sp/set')
      const rawHeader = setRes.headers.get('set-cookie') ?? ''
      const cookieValue = rawHeader.replace(/^tok=/, '').split(';')[0]

      const res = await app.fetch('/ck-sp/get', { headers: { Cookie: `tok=${cookieValue}` } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ tok: 'myvalue' })
    })

    it('returns false for a tampered signed cookie via signedCookie() picker', async () => {
      const SECRET = 'tamper-secret'

      @Controller('/ck-tamper')
      class TamperedController {
        @Get('/set')
        @Params([context()])
        async set(ctx: HonoContext) {
          await ctx.signedCookie('tok', 'original')
          return null
        }

        @Get('/check')
        @Params([signedCookie('tok')])
        check(tok: string | false | undefined) {
          return { valid: tok !== false && tok !== undefined }
        }
      }
      void [TamperedController]

      const app = newHTTP(honoAdapterFactory(new Hono(), { cookies: { secret: SECRET } }))
      await app.ready()

      // Get a valid signed cookie, then replace value part to tamper it
      const setRes = await app.fetch('/ck-tamper/set')
      const rawHeader = setRes.headers.get('set-cookie') ?? ''
      const signedValue = rawHeader.replace(/^tok=/, '').split(';')[0]
      // Replace value before the last dot: "original.HMAC" → "tampered.HMAC"
      const lastDot = signedValue.lastIndexOf('.')
      const tamperedValue = `tampered${signedValue.slice(lastDot)}`

      const res = await app.fetch('/ck-tamper/check', { headers: { Cookie: `tok=${tamperedValue}` } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ valid: false })
    })

    it('ctx.cookie() sets a Set-Cookie header on the response', async () => {
      @Controller('/ck')
      class SetCookieController {
        @Get('/set')
        @Params([context()])
        get(ctx: HonoContext) {
          ctx.cookie('session', 'hello', { httpOnly: true, path: '/' })
          return { ok: true }
        }
      }
      void [SetCookieController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/ck/set')
      expect(res.status).toBe(200)
      const setCookieHeader = res.headers.get('set-cookie')
      expect(setCookieHeader).toMatch(/session=hello/)
      expect(setCookieHeader).toMatch(/HttpOnly/)
    })

    it('ctx.req.cookie() reads a cookie from the request', async () => {
      @Controller('/ck')
      class GetCookieController {
        @Get('/get')
        @Params([context()])
        get(ctx: HonoContext) {
          return { value: ctx.req.cookie('token') }
        }
      }
      void [GetCookieController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/ck/get', { headers: { Cookie: 'token=secret' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ value: 'secret' })
    })

    it('ctx.signedCookie() write and ctx.req.signedCookie() read round-trip correctly', async () => {
      const SECRET = 'round-trip-secret'

      @Controller('/ck')
      class RoundTripController {
        @Get('/write')
        @Params([context()])
        async write(ctx: HonoContext) {
          await ctx.signedCookie('data', 'payload')
          return null
        }

        @Get('/read')
        @Params([context()])
        async read(ctx: HonoContext) {
          const value = await ctx.req.signedCookie('data')
          return { value }
        }
      }
      void [RoundTripController]

      const app = newHTTP(honoAdapterFactory(new Hono(), { cookies: { secret: SECRET } }))
      await app.ready()

      const writeRes = await app.fetch('/ck/write')
      const rawHeader = writeRes.headers.get('set-cookie') ?? ''
      const cookieValue = rawHeader.replace(/^data=/, '').split(';')[0]

      const readRes = await app.fetch('/ck/read', { headers: { Cookie: `data=${cookieValue}` } })
      expect(readRes.status).toBe(200)
      expect(await readRes.json()).toEqual({ value: 'payload' })
    })

    it('ctx.req.signedCookie() reads a signed cookie from the request', async () => {
      const SECRET = 'req-signed-secret'

      @Controller('/ck-req-sc')
      class ReqSignedCookieController {
        @Get('/write')
        @Params([context()])
        async write(ctx: HonoContext) {
          await ctx.signedCookie('tok', 'reqvalue')
          return null
        }

        @Get('/read')
        @Params([context()])
        async read(ctx: HonoContext) {
          const value = await ctx.req.signedCookie('tok')
          return { value }
        }
      }
      void [ReqSignedCookieController]

      const app = newHTTP(honoAdapterFactory(new Hono(), { cookies: { secret: SECRET } }))
      await app.ready()

      const writeRes = await app.fetch('/ck-req-sc/write')
      const rawHeader = writeRes.headers.get('set-cookie') ?? ''
      const cookieValue = rawHeader.replace(/^tok=/, '').split(';')[0]

      const readRes = await app.fetch('/ck-req-sc/read', { headers: { Cookie: `tok=${cookieValue}` } })
      expect(readRes.status).toBe(200)
      expect(await readRes.json()).toEqual({ value: 'reqvalue' })
    })

    it('ctx.deleteCookie() clears a cookie', async () => {
      @Controller('/ck')
      class DeleteCookieController {
        @Get('/delete')
        @Params([context()])
        get(ctx: HonoContext) {
          ctx.deleteCookie('session')
          return { ok: true }
        }
      }
      void [DeleteCookieController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/ck/delete')
      expect(res.status).toBe(200)
      const setCookieHeader = res.headers.get('set-cookie')
      expect(setCookieHeader).toMatch(/session=/)
      expect(setCookieHeader).toMatch(/Max-Age=0/)
    })
  })

  describe('Context Response Methods', () => {
    it('ctx.body() sends a raw body response', async () => {
      @Controller('/resp')
      class BodyController {
        @Get('/raw')
        @Params([context()])
        get(ctx: HonoContext) {
          ctx.body('hello world')
          return null
        }
      }
      void [BodyController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/resp/raw')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hello world')
    })

    it('ctx.notFound() sends a 404 response', async () => {
      @Controller('/resp')
      class NotFoundController {
        @Get('/missing')
        @Params([context()])
        get(ctx: HonoContext) {
          ctx.notFound()
          return null
        }
      }
      void [NotFoundController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/resp/missing')
      expect(res.status).toBe(404)
    })

    it('ctx.redirect() sends a redirect response', async () => {
      @Controller('/resp')
      class RedirectController {
        @Get('/old')
        @Params([context()])
        get(ctx: HonoContext) {
          ctx.redirect('/resp/new', 301)
          return null
        }
      }
      void [RedirectController]

      const app = newHTTP(honoAdapterFactory(new Hono()))
      await app.ready()
      const res = await app.fetch('/resp/old', { redirect: 'manual' })
      expect(res.status).toBe(301)
      expect(res.headers.get('location')).toBe('/resp/new')
    })
  })
})
