import { $i, CaffeineIoC, Scopes } from '@caffeinejs/di'
import { Controller, Get, Router, createWebApplication } from '@caffeinejs/http'
import { Guard, type GuardReturn } from '@caffeinejs/http/guards'
import { $t } from '@caffeinejs/std'
import { describe, expect, it, vi } from 'vitest'

import { ErrTestClientAlreadyReady, ErrTestClientTarget, newTestContainer, testClient } from './index.js'

const petSchema = $t.Object({ id: $t.Integer(), name: $t.String() })

class Greeter {
  // Private, so a proxy standing in for the instance would break on it. It must not be proxied.
  readonly #greeting = 'hello'

  greet(name: string): string {
    return `${this.#greeting} ${name}`
  }
}

class Repository {
  all(): string[] {
    return ['real']
  }
}

/** A router with no dependencies, covering the shapes a request can take. */
function newPets() {
  return new Router('/pets')
    .get('/', () => [{ id: 1, name: 'Rex' }])
    .post('/')
    .schema({ body: petSchema })
    .status(201)
    .handler(ctx => ctx.body({ created: ctx.req.body() }))
    .get('/search')
    .handler(ctx => ({ tags: ctx.req.queries('tag') ?? [], tenant: ctx.req.header('x-tenant') }))
    .get('/missing')
    .handler(ctx => ctx.status(404).body({ detail: 'gone' }))
    .get('/:id')
    .schema({ params: $t.Object({ id: $t.Integer() }), response: { 200: petSchema } })
    .handler(ctx => ({ id: ctx.req.param().id, name: 'Rex' }))
}

describe('testClient()', () => {
  describe('given routers rather than an application', () => {
    it('should answer without the test building or readying anything', async () => {
      await using client = testClient(newPets())

      expect(await (await client.pets.get()).json()).toEqual([{ id: 1, name: 'Rex' }])
    })

    it('should place each path parameter in its own segment', async () => {
      await using client = testClient(newPets())

      expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
    })

    it('should repeat a query key per array item and send per-call headers', async () => {
      await using client = testClient(newPets())

      const res = await client.pets.search.get({ query: { tag: ['a', 'b'] }, headers: { 'x-tenant': 't1' } })

      expect(await res.json()).toEqual({ tags: ['a', 'b'], tenant: 't1' })
    })

    it('should send an object body as JSON and report the declared status', async () => {
      await using client = testClient(newPets())

      const res = await client.pets.post({ body: { id: 2, name: 'Milou' } })

      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ created: { id: 2, name: 'Milou' } })
    })

    it('should resolve a failing status rather than throwing it', async () => {
      await using client = testClient(newPets())

      const res = await client.pets.missing.get()

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ detail: 'gone' })
    })

    it('should mount every router it was handed, prefixes included', async () => {
      const pets = new Router('/pets').get('/', () => ({ from: 'pets' }))
      const petsAdmin = new Router('/pets/admin').get('/', () => ({ from: 'admin' }))
      const orders = new Router('/orders').get('/', () => ({ from: 'orders' }))

      await using client = testClient([pets, petsAdmin, orders])

      expect(await (await client.pets.get()).json()).toEqual({ from: 'pets' })
      expect(await (await client.pets.admin.get()).json()).toEqual({ from: 'admin' })
      expect(await (await client.orders.get()).json()).toEqual({ from: 'orders' })
    })

    it('should route only the routers given, not a controller declared alongside', async () => {
      @Controller('/leaked')
      class LeakedController {
        @Get('/')
        index() {
          return { leaked: true }
        }
      }

      void LeakedController

      await using client = testClient(newPets())

      expect((await client.$fetch('/leaked')).status).toBe(404)
      expect((await client.$fetch('/pets')).status).toBe(200)
    })

    it('should reject an empty list of routers', () => {
      expect(() => testClient([])).toThrow(ErrTestClientTarget)
    })

    it('should reject a target that is neither an application nor a router', () => {
      expect(() => testClient({} as never)).toThrow(ErrTestClientTarget)
    })
  })

  describe('given an application', () => {
    it('should ready it, so a test does not have to', async () => {
      const app = createWebApplication().build().mount(newPets())

      // Deliberately not readied: an un-readied application has registered no routes and answers 404.
      await using client = testClient(app)

      expect(await (await client.pets.get()).json()).toEqual([{ id: 1, name: 'Rex' }])
    })

    it('should expose the application and its container', async () => {
      const app = createWebApplication().build().mount(newPets())
      await using client = testClient(app)

      expect(client.$app).toBe(app)
      expect(client.$container).toBe(app.container)
    })

    it('should leave it configurable until the first request readies it', async () => {
      const seen: string[] = []
      await using client = testClient(newPets())

      client.$app.use(async (ctx, next) => {
        seen.push(ctx.req.url)
        return next()
      })

      await client.pets.get()

      expect(seen).toEqual(['/pets'])
    })
  })

  describe('given dependencies to replace', () => {
    function newGreet() {
      return new Router('/greet')
        .inject({ greeter: Greeter, missing: $i.optional(class Absent {}) })
        .get('/:name')
        .handler((ctx, deps) => ({ message: deps.greeter.greet(ctx.req.param('name')!) }))
    }

    it('should hand the handler what "inject" names, by the name it reads it under', async () => {
      await using client = testClient(newGreet(), {
        inject: { greeter: { greet: (name: string) => `MOCK ${name}` } },
      })

      expect(await (await client.greet({ name: 'ada' }).get()).json()).toEqual({ message: 'MOCK ada' })
    })

    it('should leave a dependency it did not replace resolving as it did', async () => {
      await using client = testClient(newGreet(), { bind: c => c.bind(Greeter, t => t.toSelf()) })

      // Greeter reads a private field, which would throw if the instance itself had been proxied.
      expect(await (await client.greet({ name: 'ada' }).get()).json()).toEqual({ message: 'hello ada' })
    })

    it('should replace the name in every router that declares it', async () => {
      const greet = newGreet()
      const hail = new Router('/hail')
        .inject({ greeter: Greeter })
        .get('/:name')
        .handler((ctx, deps) => ({ message: deps.greeter.greet(ctx.req.param('name')!) }))

      await using client = testClient([greet, hail], {
        inject: { greeter: { greet: (name: string) => `MOCK ${name}` } },
      })

      expect(await (await client.greet({ name: 'ada' }).get()).json()).toEqual({ message: 'MOCK ada' })
      expect(await (await client.hail({ name: 'ada' }).get()).json()).toEqual({ message: 'MOCK ada' })
    })

    it('should replace a dependency of an application that has not been readied', async () => {
      const app = createWebApplication().build().mount(newGreet())

      await using client = testClient(app, {
        inject: { greeter: { greet: (name: string) => `MOCK ${name}` } },
      })

      expect(await (await client.greet({ name: 'ada' }).get()).json()).toEqual({ message: 'MOCK ada' })
    })

    it('should refuse to replace a dependency of an application that is already ready', async () => {
      const container = new CaffeineIoC({ decorators: false })
      container.bind(Greeter, t => t.toSelf())

      const app = createWebApplication({ container }).build().mount(newGreet())
      await app.ready()

      try {
        // The bags were built during setup, so a shim installed now would be read by nothing.
        expect(() => testClient(app, { inject: { greeter: {} as Greeter } })).toThrow(ErrTestClientAlreadyReady)
      } finally {
        await app.close()
      }
    })

    it('should take a container the test built', async () => {
      const source = new CaffeineIoC({ decorators: false })
      source.bind(Repository, t => t.toSelf())

      const router = new Router('/items')
        .inject({ repository: Repository })
        .get('/')
        .handler((_ctx, deps) => ({ items: deps.repository.all() }))

      await using client = testClient(router, {
        container: newTestContainer(source)
          .overrideWithMock(Repository, { all: () => ['mocked'] })
          .build(),
      })

      expect(await (await client.items.get()).json()).toEqual({ items: ['mocked'] })
    })

    it('should resolve a transient binding per access, as it would without a client', async () => {
      class Counter {
        static created = 0
        readonly id = ++Counter.created
      }

      const router = new Router('/count')
        .inject({ counter: Counter })
        .get('/')
        .handler((_ctx, deps) => ({ id: deps.counter.id }))

      await using client = testClient(router, {
        bind: c => c.bind(Counter, t => t.toSelf().lifetime(Scopes.TRANSIENT)),
        inject: { unused: 'ignored' } as never,
      })

      const first = (await (await client.count.get()).json()) as { id: number }
      const second = (await (await client.count.get()).json()) as { id: number }

      expect(second.id).toBe(first.id + 1)
    })

    it('should restore the container it was given when the client closes', async () => {
      const container = new CaffeineIoC({ decorators: false })
      container.bind(Greeter, t => t.toSelf())

      const before = Object.getOwnPropertyDescriptor(container, 'resolver')
      const client = testClient(newGreet(), { container, inject: { greeter: {} as Greeter } })

      await client.$ready()
      expect(Object.getOwnPropertyDescriptor(container, 'resolver')).not.toEqual(before)

      await client.$close()

      expect(Object.getOwnPropertyDescriptor(container, 'resolver')).toEqual(before)
    })
  })

  describe('given a builder to configure', () => {
    it('should apply what "configure" set before the application was built', async () => {
      class DenyGuard implements Guard {
        guard(): GuardReturn {
          return false
        }
      }

      const router = new Router('/secret').get('/', () => ({ ok: true }))

      await using client = testClient(router, {
        configure: builder => {
          builder.container.bind(DenyGuard, t => t.toSelf())
          builder.guards(guards => guards.global(DenyGuard))
        },
      })

      // The guard is registered on the builder, so it reaches a route the router never mentions it on.
      expect((await client.secret.get()).status).toBe(403)
    })
  })

  describe('given a per-client request init', () => {
    it('should send its headers on every request, and let a call override them', async () => {
      await using client = testClient(newPets(), { init: { headers: { 'x-tenant': 'from-init' } } })

      expect(await (await client.pets.search.get()).json()).toMatchObject({ tenant: 'from-init' })
      expect(await (await client.pets.search.get({ headers: { 'x-tenant': 'from-call' } })).json()).toMatchObject({
        tenant: 'from-call',
      })
    })

    it('should ignore a method set there, since the verb decides it', async () => {
      await using client = testClient(newPets(), { init: { method: 'DELETE' } })

      expect((await client.pets.get()).status).toBe(200)
    })
  })

  describe('given the escape hatches', () => {
    it('should reach a route by raw path', async () => {
      await using client = testClient(newPets())

      expect(await (await client.$fetch('/pets/7')).json()).toEqual({ id: 7, name: 'Rex' })

      const created = await client.$fetch('/pets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 3, name: 'Idefix' }),
      })

      expect(created.status).toBe(201)
    })

    it('should reach a route by method and path', async () => {
      await using client = testClient(newPets())

      const res = await client.$request('GET', '/pets/:id', { params: { id: 9 } })

      expect(await res.json()).toEqual({ id: 9, name: 'Rex' })
    })
  })

  describe('given a client that is done with', () => {
    it('should close the application it built', async () => {
      const client = testClient(newPets())
      await client.pets.get()

      const close = vi.spyOn(client.$app, 'close')
      await client.$close()

      expect(close).toHaveBeenCalledTimes(1)
    })

    it('should close an application it was given', async () => {
      const app = createWebApplication().build().mount(newPets())
      const client = testClient(app)
      await client.pets.get()

      await client.$close()

      // A closed application refuses to serve; readying it again does not bring it back.
      await expect(app.fetch('/pets')).rejects.toThrow()
    })

    it('should close once, however many times it is asked', async () => {
      const client = testClient(newPets())
      await client.pets.get()

      const close = vi.spyOn(client.$app, 'close')

      await client.$close()
      await client.$close()

      expect(close).toHaveBeenCalledTimes(1)
    })

    it('should close a client that never made a request', async () => {
      const client = testClient(newPets())

      await expect(client.$close()).resolves.toBeUndefined()
    })
  })
})
