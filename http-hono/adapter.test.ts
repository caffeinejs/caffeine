import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { address, Controller, Get, header, Method, method, newHTTP, Params, param, path, port, query, signal, url } from '@caffeinejs/http'
import { CaffeineIoC, Scopes, Injectable, Lifetime } from '@caffeinejs/core'
import { HonoAdapter } from './adapter.js'
import { honoAdapterFactory } from './adapter_factory.js'

describe('Hono Adapter', () => {
  it('exposes the underlying server instance', async () => {
    const app = new Hono()
    app.get('/', c => c.json({ ok: true }))

    const adapter = new HonoAdapter(new CaffeineIoC(), app)
    await adapter.setup({ routers: [] })

    expect(adapter.server()).toBe(app)
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
})
