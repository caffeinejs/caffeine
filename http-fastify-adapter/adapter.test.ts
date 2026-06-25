import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import fastify from 'fastify'
import { address, Controller, Get, header, Method, method, newHTTP, Params, param, path, port, query, signal, url } from '@caffeinejs/http'
import { CaffeineIoC, Scopes } from '@caffeinejs/core'
import { Injectable, Lifetime } from '@caffeinejs/core/decorators'
import { FastifyAdapter } from './adapter.js'
import { fastifyAdapterFactory } from './adapter_factory.js'

describe('Fastify Adapter', () => {
  it('exposes the underlying server as a Supertest-compatible listener', async () => {
    const app = fastify()
    app.get('/', () => ({ ok: true }))

    const adapter = new FastifyAdapter(new CaffeineIoC(), app, [])
    await adapter.ready()

    expect(adapter.instance()).toBe(app)
    await supertest(adapter.instance().server).get('/')
      .expect(200, { ok: true })
  })

  it('exposes the underlying fastify instance and can be tested with .inject()', async () => {
    const app = fastify()
    app.get('/', () => ({ ok: true }))

    const adapter = new FastifyAdapter(new CaffeineIoC(), app, [])
    await adapter.ready()
    const result = await adapter.instance().inject('/')

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

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()

      await adapter.ready()

      await supertest(adapter.instance().server)
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

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const res = await adapter.instance().inject({ method: 'GET', url: '/test/pickers?foo=bar' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        url: '/test/pickers?foo=bar',
        path: '/test/pickers',
        hasSignal: true,
        port: expect.any(Number),
        address: expect.any(String),
      })
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

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      for (const method of methods) {
        const res = await adapter.instance().inject({ method, url: '/method-test/action' })
        expect(res.json()).toEqual({ method })
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

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const r1 = await adapter.instance().inject({ method: 'GET', url: '/req-ctrl/id' })
      const r2 = await adapter.instance().inject({ method: 'GET', url: '/req-ctrl/id' })

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
        constructor(private readonly svc: RequestScopedService) {}

        @Get('/svc-id')
        get() {
          return { id: this.svc.id }
        }
      }

      void [TransientController]

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const r1 = await adapter.instance().inject({ method: 'GET', url: '/transient-ctrl/svc-id' })
      const r2 = await adapter.instance().inject({ method: 'GET', url: '/transient-ctrl/svc-id' })

      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)
      expect(r1.json().id).toBe(1)
      expect(r2.json().id).toBe(2)
    })
  })
})
