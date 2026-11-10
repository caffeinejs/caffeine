import { AsyncLocalStorage } from 'node:async_hooks'

import { $t } from '@caffeinejs/application/schema'
import { contextKey, ExecutionContext, Scopes, Injectable, Lifetime } from '@caffeinejs/di'
import type { FastifyError, FastifyInstance } from 'fastify'
import { describe, it, expect } from 'vitest'

import { $p } from '../../core/routing/picker.js'
import {
  Catch,
  Controller,
  Get,
  Method,
  Router,
  Args,
  type ErrorHandler,
  type IContext,
  type WebApplication,
} from '../../index.js'
import { Context, createWebApplication, newRouter } from './index.js'

describe('Fastify Adapter', () => {
  // Binds a real ephemeral socket (unlike the app.request() tests below), so it can hang up under
  // parallel-suite port/event-loop contention. Retry keeps the real-socket smoke test without making it
  // flaky.
  it('binds a real listener and serves it over the network', { retry: 2 }, async () => {
    let seen: FastifyInstance | undefined
    const app = createWebApplication().serverCallback((_context, server) => {
      seen = server
      server.get('/', () => ({ ok: true }))
    })
    await app.run()

    try {
      expect(app.instance).toBe(seen)
      expect(app.address!.port).toBeGreaterThan(0)

      // Native fetch, not app.request(): the point is that traffic reaches the process through a socket.
      const res = await fetch(`${app.address!.origin}/`)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.close()
    }
  })

  it('exposes the underlying fastify instance and can be tested with app.request()', async () => {
    const app = createWebApplication().serverCallback((_context, server) => {
      server.get('/', () => ({ ok: true }))
    })
    await app.bootstrap()

    const result = await app.request('/')

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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.request('/users/1?filter=test', { headers: { 'x-test': 'test' } })

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
        get(u: string, p: string, sig: AbortSignal, po: number | null, addr: string | undefined) {
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.request('http://localhost:8080/test/pickers?foo=bar')

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        url: '/test/pickers?foo=bar',
        path: '/test/pickers',
        hasSignal: true,
        port: 8080,
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.request('/async-pick/value')
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.request('/mixed-pick/42')
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

      const app = createWebApplication()
      await app.bootstrap()

      for (const m of methods) {
        const res = await app.request('/method-test/action', { method: m })
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

      const app = createWebApplication()
      await app.bootstrap()

      const r1 = await app.request('/req-ctrl/id')
      const r2 = await app.request('/req-ctrl/id')

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
        constructor(private readonly svc: RequestScopedService) {}

        @Get('/svc-id')
        get() {
          return { id: this.svc.id }
        }
      }

      void [TransientController]

      const app = createWebApplication()
      await app.bootstrap()

      const r1 = await app.request('/transient-ctrl/svc-id')
      const r2 = await app.request('/transient-ctrl/svc-id')

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect(await r1.json()).toEqual({ id: 1 })
      expect(await r2.json()).toEqual({ id: 2 })
    })

    // The request context is bound request-scoped: resolved from the container, it is the very one the handler is
    // handed, and each of two requests in flight at once gets its own, across an await.
    it('resolves the request context from the container as the one the handler got', async () => {
      const router = new Router('/ctx-di')
      router
        .get('/')
        .inject({ injected: Context })
        .handler(async (ctx, deps) => {
          const first = deps.injected
          await new Promise(resolve => setTimeout(resolve, 5))
          return { same: first === ctx && deps.injected === first, probe: first.req.header('x-probe') }
        })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const [a, b] = await Promise.all([
        app.request('/ctx-di', { headers: { 'x-probe': 'a' } }),
        app.request('/ctx-di', { headers: { 'x-probe': 'b' } }),
      ])
      expect(await a.json()).toEqual({ same: true, probe: 'a' })
      expect(await b.json()).toEqual({ same: true, probe: 'b' })

      await app.close()
    })

    // An application or a test container that binds its own storage must get every request framed in it, and each
    // request starts from a clean frame there: nothing the caller of the server had set leaks into a handler.
    it('opens each request on a clean frame of the context storage the application binds', async () => {
      const storage = new AsyncLocalStorage<ExecutionContext>()
      const kCaller = contextKey<string>('caller')
      const router = new Router('/own-storage')
      router
        .get('/')
        .inject({ injected: Context })
        .handler((ctx, deps) => ({ leaked: storage.getStore()?.get(kCaller) ?? null, same: deps.injected === ctx }))

      const app = createWebApplication().mount(router)
      app.container.bindContextStorage(storage)
      await app.bootstrap()

      const res = await storage.run(ExecutionContext.ROOT.with(kCaller, 'test'), () => app.request('/own-storage'))
      expect(await res.json()).toEqual({ leaked: null, same: true })

      await app.close()
    })
  })
})

@Catch(Error)
class MessageEcho implements ErrorHandler<FastifyError> {
  async handle(ctx: IContext, err: FastifyError) {
    ctx.status(409)
    return { message: err.message }
  }
}
void [MessageEcho]

describe('the schema error formatter', () => {
  // 1,000 items, each missing 20 required members.
  const Twenty = $t.Object({
    items: $t.Array($t.Object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, $t.String()])))),
  })
  const EMPTY_ITEMS = JSON.stringify({ items: Array.from({ length: 1_000 }, () => ({})) })

  async function messageOf(app: WebApplication<any, any, any, any>): Promise<unknown> {
    await app.bootstrap()
    const res = await app.request('/fmt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: EMPTY_ITEMS,
    })
    await app.close()

    return ((await res.json()) as { message: unknown }).message
  }

  function route() {
    return newRouter('/fmt')
      .catchBy([MessageEcho])
      .post('/', { body: Twenty }, () => ({ ok: true }))
  }

  // Fastify's own would join all 20,000 of Ajv's messages into the one an application handler and every log line read.
  it('names the slot and the count rather than every message', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { ajv: { customOptions: { allErrors: true } } } }))
      .mount(route())

    expect(await messageOf(app)).toBe('Invalid request body: 20000 errors')
  })

  it('keeps a formatter the factory settings name', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { schemaErrorFormatter: (_errors, slot) => new Error(`own ${slot}`) } }))
      .mount(route())

    expect(await messageOf(app)).toBe('own body')
  })

  it('gives way to a formatter a server callback sets', async () => {
    const app = createWebApplication()
      .serverCallback((_kit, instance) => {
        instance.setSchemaErrorFormatter((_errors, slot) => new Error(`late ${slot}`))
      })
      .mount(route())

    expect(await messageOf(app)).toBe('late body')
  })
})

// Installing the formatter must leave the application's Ajv options as they were, alone or beside others.
describe('the Ajv options an application sets', () => {
  it.each([
    ['alone', { allErrors: true }],
    ['beside another option', { allErrors: true, coerceTypes: false }],
  ])('keeps allErrors %s', async (_, customOptions) => {
    const app = createWebApplication()
      .server(() => ({ factory: { ajv: { customOptions } } }))
      .mount(
        newRouter('/all').post('/', { body: $t.Object({ a: $t.Integer(), b: $t.Integer() }) }, () => ({ ok: true })),
      )
    await app.bootstrap()

    const res = await app.request('/all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x', b: 'y' }),
    })
    await app.close()

    expect(((await res.json()) as { errors: unknown[] }).errors).toHaveLength(2)
  })
})
