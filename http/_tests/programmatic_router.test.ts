import { describe, expect, it } from 'vitest'
import { $i, CaffeineIoC, Scopes } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std'
import { Controller, Get, Router, blend, createWebApplication } from '../index.js'

class Greeter {
  greet(name: string) {
    return `hello ${name}`
  }
}

class Counter {
  static created = 0
  readonly id = ++Counter.created
}

function newApp(configure?: (container: CaffeineIoC) => void) {
  const container = new CaffeineIoC()
  configure?.(container)
  return createWebApplication({ container })
}

describe('programmatic router', () => {
  describe('given a router with no configuration beyond its routes', () => {
    it('should answer on the joined group and route path', async () => {
      const router = new Router('/pets')
      router.get('/').handler(ctx => ctx.body({ list: true }))
      router.get('/:id').handler(ctx => ctx.body({ id: ctx.req.param('id') }))
      router.post('/').handler(ctx => ctx.status(201).body({ created: true }))

      const app = newApp().build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/pets')).json()).toEqual({ list: true })
      expect(await (await app.fetch('/pets/7')).json()).toEqual({ id: '7' })

      const created = await app.fetch('/pets', { method: 'POST' })
      expect(created.status).toBe(201)

      await app.close()
    })
  })

  describe('given a handler written inline on the verb', () => {
    it('should serve the route and let the next one chain off it', async () => {
      const router = new Router('/pets')
        .get('/', ctx => ctx.body({ list: true }))
        .get('/:id', ctx => ctx.body({ id: ctx.req.param('id') }))
        .post('/', ctx => ctx.status(201).body({ created: true }))

      const app = newApp().build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/pets')).json()).toEqual({ list: true })
      expect(await (await app.fetch('/pets/7')).json()).toEqual({ id: '7' })
      expect((await app.fetch('/pets', { method: 'POST' })).status).toBe(201)

      await app.close()
    })

    it('should validate against a schema declared before it', async () => {
      const router = new Router('/orders').post(
        '/:id',
        {
          params: $t.Object({ id: $t.Integer() }),
          body: $t.Object({ quantity: $t.Integer() }),
        },
        ctx => ctx.body({ id: ctx.req.param().id, quantity: ctx.req.body().quantity }),
      )

      const app = newApp().build().mount(router)
      await app.ready()

      const ok = await app.fetch('/orders/10', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 2 }),
      })

      expect(await ok.json()).toEqual({ id: 10, quantity: 2 })

      const bad = await app.fetch('/orders/10', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 'two' }),
      })

      expect(bad.status).toBe(400)

      await app.close()
    })

    it('should mix with chained routes and name them the same way', async () => {
      const router = new Router('/pets')
        .get('/', ctx => ctx.body({ list: true }))
        .put('/:id')
        .handler(ctx => ctx.body({ replaced: ctx.req.param('id') }))
        .delete('/:id', ctx => ctx.status(204).body(null))

      const app = newApp().build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/pets')).json()).toEqual({ list: true })
      expect(await (await app.fetch('/pets/3', { method: 'PUT' })).json()).toEqual({ replaced: '3' })
      expect((await app.fetch('/pets/3', { method: 'DELETE' })).status).toBe(204)

      expect(app.routeGroups.flatMap(group => group.routes.map(route => route.name)))
        .toEqual(['get_index', 'put_id', 'delete_id'])

      await app.close()
    })

    it('should answer every method of an explicit route', async () => {
      const router = new Router('/pets').route(['GET', 'POST'], '/ping', ctx => ctx.body({ pong: true }))

      const app = newApp().build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/pets/ping')).json()).toEqual({ pong: true })
      expect(await (await app.fetch('/pets/ping', { method: 'POST' })).json()).toEqual({ pong: true })

      await app.close()
    })

    it('should hand the group dependencies over as the second argument', async () => {
      const router = new Router('/greet')
        .inject({ greeter: Greeter })
        .get('/:name', (ctx, deps) => ctx.body({ message: deps.greeter.greet(ctx.req.param().name) }))

      const app = newApp(c => c.bind(Greeter).toSelf()).build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/greet/ada')).json()).toEqual({ message: 'hello ada' })

      await app.close()
    })
  })

  describe('given a route that declares a schema', () => {
    it('should validate the request and type the context slots', async () => {
      const router = new Router('/orders')
      router
        .post('/:id')
        .schema({
          params: $t.Object({ id: $t.Integer() }),
          body: $t.Object({ quantity: $t.Integer() }),
        })
        .handler(ctx => ctx.body({ id: ctx.req.param().id, quantity: ctx.req.body().quantity }))

      const app = newApp().build().mount(router)
      await app.ready()

      const ok = await app.fetch('/orders/10', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 2 }),
      })
      expect(await ok.json()).toEqual({ id: 10, quantity: 2 })

      const bad = await app.fetch('/orders/10', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 'two' }),
      })
      expect(bad.status).toBe(400)

      await app.close()
    })
  })

  describe('given injected dependencies', () => {
    it('should hand the handler a bag keyed by the names it declared', async () => {
      const router = new Router('/greet')
      router
        .get('/:name')
        .inject({ greeter: Greeter, missing: $i.optional(class Absent { }) })
        .handler((ctx, deps) => ctx.body({
          message: deps.greeter.greet(ctx.req.param('name')!),
          missing: deps.missing === undefined,
        }))

      const app = newApp(c => c.bind(Greeter).toSelf()).build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/greet/ada')).json())
        .toEqual({ message: 'hello ada', missing: true })

      await app.close()
    })

    it('should resolve the same bag when the spec was built from the helpers handed over', async () => {
      const router = new Router('/greet')
        .inject(i => ({ greeter: Greeter, missing: i.optional(class Absent { }) }))
        .get('/:name')
        .inject(i => ({ label: i.just('greeter') }))
        .handler((ctx, deps) => ctx.body({
          message: deps.greeter.greet(ctx.req.param().name),
          missing: deps.missing === undefined,
          label: deps.label,
        }))

      const app = newApp(c => c.bind(Greeter).toSelf()).build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/greet/ada')).json())
        .toEqual({ message: 'hello ada', missing: true, label: 'greeter' })

      await app.close()
    })

    it('should keep a request-scoped binding per request when reached through a provider', async () => {
      Counter.created = 0

      const router = new Router('/provided')
      router.get('/').inject(i => ({ counter: i.provide(Counter) })).handler((_ctx, deps) => ({
        first: deps.counter.get().id,
        second: deps.counter.get().id,
      }))

      const app = newApp(c => c.bind(Counter).toSelf().lifetime(Scopes.REQUEST)).build().mount(router)
      await app.ready()

      const one = await (await app.fetch('/provided')).json() as { first: number, second: number }
      const two = await (await app.fetch('/provided')).json() as { first: number, second: number }

      expect(one.first).toBe(one.second)
      expect(one.first).not.toBe(two.first)

      await app.close()
    })

    it('should pass undefined when nothing was injected', async () => {
      const router = new Router('/plain')
      router.get('/').handler((_ctx, deps) => ({ deps: deps === undefined }))

      const app = newApp().build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/plain')).json()).toEqual({ deps: true })

      await app.close()
    })

    it('should resolve a request-scoped dependency once per request and a singleton once', async () => {
      Counter.created = 0

      const scopedRouter = new Router('/scoped')
      scopedRouter.get('/').inject({ counter: Counter }).handler((_ctx, deps) => ({ id: deps.counter.id }))

      const scoped = newApp(c => c.bind(Counter).toSelf().lifetime(Scopes.REQUEST)).build().mount(scopedRouter)
      await scoped.ready()

      const first = await (await scoped.fetch('/scoped')).json() as { id: number }
      const second = await (await scoped.fetch('/scoped')).json() as { id: number }
      expect(first.id).not.toBe(second.id)
      await scoped.close()

      const singletonRouter = new Router('/singleton')
      singletonRouter.get('/').inject({ counter: Counter }).handler((_ctx, deps) => ({ id: deps.counter.id }))

      const singleton = newApp(c => c.bind(Counter).toSelf()).build().mount(singletonRouter)
      await singleton.ready()

      const third = await (await singleton.fetch('/singleton')).json() as { id: number }
      const fourth = await (await singleton.fetch('/singleton')).json() as { id: number }
      expect(third.id).toBe(fourth.id)
      await singleton.close()
    })
  })

  describe('given nested groups', () => {
    it('should inherit path, configuration and dependencies, and let the inner one override', async () => {
      const router = new Router('/api')
        .inject({ greeter: Greeter })
        .header('x-group', 'api')
        .produces('application/json')

      router.get('/root').handler((_ctx, deps) => ({ from: deps.greeter.greet('root') }))

      router.group('/v1', v1 => {
        v1.header('x-group', 'v1')
        v1.get('/hello').handler((_ctx, deps) => ({ from: deps.greeter.greet('v1') }))

        v1.group('/deep', deep => {
          deep.get('/hello').handler((_ctx, deps) => ({ from: deps.greeter.greet('deep') }))
        })
      })

      const app = newApp(c => c.bind(Greeter).toSelf()).build().mount(router)
      await app.ready()

      const root = await app.fetch('/api/root')
      expect(root.headers.get('x-group')).toBe('api')
      expect(await root.json()).toEqual({ from: 'hello root' })

      const v1 = await app.fetch('/api/v1/hello')
      expect(v1.headers.get('x-group')).toBe('v1')
      expect(await v1.json()).toEqual({ from: 'hello v1' })

      const deep = await app.fetch('/api/v1/deep/hello')
      expect(deep.headers.get('x-group')).toBe('v1')
      expect(await deep.json()).toEqual({ from: 'hello deep' })

      await app.close()
    })
  })

  describe('given a router mounted into another', () => {
    it('should register it under the host path', async () => {
      const inner = new Router('/inner')
      inner.get('/ping').handler(() => ({ pong: true }))

      const outer = new Router('/outer')
      outer.mount(inner)
      outer.mount('/prefixed', inner)

      const app = newApp().build().mount(outer)
      await app.ready()

      expect(await (await app.fetch('/outer/inner/ping')).json()).toEqual({ pong: true })
      expect(await (await app.fetch('/outer/prefixed/inner/ping')).json()).toEqual({ pong: true })

      await app.close()
    })
  })

  describe('given routes declared as separate statements', () => {
    it('should serve every one of them when their handles are blended', async () => {
      const pets = new Router('/pets')
      const list = pets.get('/').handler(() => ({ list: true }))
      const add = pets.post('/').handler(ctx => ctx.status(201).body({ created: true }))

      const app = newApp().build().mount(blend(list, add))
      await app.ready()

      expect(await (await app.fetch('/pets')).json()).toEqual({ list: true })
      expect((await app.fetch('/pets', { method: 'POST' })).status).toBe(201)

      await app.close()
    })

    it('should add the router once however many of its handles are named', async () => {
      const pets = new Router('/pets')
      const list = pets.get('/').handler(() => ({ list: true }))
      const add = pets.post('/').handler(() => ({ created: true }))

      const app = newApp().build().mount(pets, list, add)
      await app.ready()

      expect(await (await app.fetch('/pets')).json()).toEqual({ list: true })

      await app.close()
    })

    it('should add the router once across separate mount calls', async () => {
      const pets = new Router('/pets')
      const list = pets.get('/').handler(() => ({ list: true }))
      const add = pets.post('/').handler(() => ({ created: true }))

      const app = newApp().build()
      app.mount(list)
      app.mount(add)
      await app.ready()

      expect(await (await app.fetch('/pets')).json()).toEqual({ list: true })

      await app.close()
    })
  })

  describe('given one router mounted into two different hosts', () => {
    it('should register it under each of them', async () => {
      const shared = new Router('/shared')
      shared.get('/ping').handler(() => ({ pong: true }))

      const a = new Router('/a').mount(shared)
      const b = new Router('/b').mount(shared)

      const app = newApp().build().mount(a, b)
      await app.ready()

      expect(await (await app.fetch('/a/shared/ping')).json()).toEqual({ pong: true })
      expect(await (await app.fetch('/b/shared/ping')).json()).toEqual({ pong: true })

      await app.close()
    })
  })

  describe('given several routers mounted under one path', () => {
    it('should register each of them beneath it', async () => {
      const pets = new Router('/pets')
      pets.get('/').handler(() => ({ pets: true }))

      const orders = new Router('/orders')
      orders.get('/').handler(() => ({ orders: true }))

      const app = newApp().build().mount(new Router('/api').mount('/v1', pets, orders))
      await app.ready()

      expect(await (await app.fetch('/api/v1/pets')).json()).toEqual({ pets: true })
      expect(await (await app.fetch('/api/v1/orders')).json()).toEqual({ orders: true })

      await app.close()
    })
  })

  describe('given routers and controllers in the same application', () => {
    it('should serve both', async () => {
      @Controller('/decorated')
      class DecoratedController {
        @Get('/ping')
        ping() {
          return { source: 'decorator' }
        }
      }
      void [DecoratedController]

      const router = new Router('/programmatic')
      router.get('/ping').handler(() => ({ source: 'router' }))

      const app = newApp().build().mount(router)
      await app.ready()

      expect(await (await app.fetch('/decorated/ping')).json()).toEqual({ source: 'decorator' })
      expect(await (await app.fetch('/programmatic/ping')).json()).toEqual({ source: 'router' })

      await app.close()
    })
  })

  describe('given the same router mounted into two applications', () => {
    it('should build it fresh for each rather than accumulating routes', async () => {
      const router = new Router('/shared')
      router.get('/ping').handler(() => ({ ok: true }))

      const first = newApp().build().mount(router)
      await first.ready()
      expect((await first.fetch('/shared/ping')).status).toBe(200)
      await first.close()

      const second = newApp().build().mount(router)
      await second.ready()
      expect((await second.fetch('/shared/ping')).status).toBe(200)
      await second.close()
    })
  })

  describe('given a chain that was never closed', () => {
    it('should fail while routing is built', async () => {
      const router = new Router('/broken')
      router.get('/orphan')

      const app = newApp().build().mount(router)

      await expect(app.ready()).rejects.toThrow(/declares no handler/)
    })
  })

  describe('given a router mounted after start-up', () => {
    it('should refuse rather than silently do nothing', async () => {
      const app = newApp().build()
      await app.ready()

      expect(() => app.mount(new Router('/late'))).toThrow(/already been built/)

      await app.close()
    })
  })
})
