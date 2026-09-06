import { Router, blend, createWebApplication, type RouteDef, type RoutesOf } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { describe, expectTypeOf, it } from 'vitest'

import { brewer, type Fetchable } from '../brewer.js'
import type { RouteContract } from '../contract.js'
import type { BrewResponse } from '../response.js'

const petSchema = $t.Object({ id: $t.Integer(), name: $t.String() })
const problemSchema = $t.Object({ detail: $t.String() })

const pets = new Router('/pets')
  .get('/')
  .handler(() => [] as Array<{ id: number; name: string }>)
  .post('/')
  .schema({ body: petSchema })
  .handler(() => ({ created: true }))
  .get('/:id')
  .schema({ params: $t.Object({ id: $t.Integer() }), response: { 200: petSchema } })
  .handler(ctx => ctx.body())
  .get('/:petID/orders/:orderID')
  .schema({ params: $t.Object({ petID: $t.Integer(), orderID: $t.String() }) })
  .handler(() => ({ order: 1 }))
  .get('/search')
  .schema({ querystring: $t.Object({ q: $t.String() }), headers: $t.Object({ 'x-tenant': $t.String() }) })
  .handler(() => [] as string[])
  .get('/:id/owner')
  .schema({
    params: $t.Object({ id: $t.Integer() }),
    response: { 200: petSchema, 404: problemSchema, '4xx': problemSchema },
  })
  .handler(ctx => ctx.body())

const app = createWebApplication().build().mount(pets)

type App = typeof app
type Pet = { id: number; name: string }
type Problem = { detail: string }

const client = brewer<App>('http://localhost')

/**
 * Holds an assertion that is checked by the compiler and never run.
 *
 * These calls would reach the network, and what is under test is the type of the call rather than its result — so
 * the body is built and dropped. `test:typecheck` is what actually reads this file.
 */
function typeOnly(_assertions: () => unknown): void {}

describe('the route contract', () => {
  it('is the shape the server describes a route with', () => {
    // The guard that makes the structural copy safe: if either side changes, this stops compiling.
    expectTypeOf<
      RouteDef<'GET', '/pets', unknown, unknown, unknown, unknown, unknown, unknown>
    >().toExtend<RouteContract>()
  })
})

describe('the tree', () => {
  it('types the response body from the response schema', () => {
    typeOnly(async () => {
      const res = await client.pets({ id: 1 }).get()

      expectTypeOf(await res.json()).toEqualTypeOf<Pet>()
    })
  })

  it('types the response body from the handler where no schema declares one', () => {
    typeOnly(async () => {
      const res = await client.pets.get()

      expectTypeOf(res).toEqualTypeOf<BrewResponse<Pet[]>>()
      expectTypeOf(await res.json()).toEqualTypeOf<Pet[]>()
    })
  })

  it('keeps the status wide, so an undeclared code can still be compared against', () => {
    typeOnly(async () => {
      const res = await client.pets({ id: 1 }).owner.get()

      // A route may always answer something it never declared — a framework 500, say. Narrowing the status to the
      // declared codes would make this a non-overlapping comparison and stop it compiling.
      expectTypeOf(res.status).toEqualTypeOf<number>()
    })
  })

  it('types the body from the status the caller checked', () => {
    typeOnly(async () => {
      const res = await client.pets({ id: 1 }).owner.get()

      if (res.status === 200) {
        expectTypeOf(await res.json()).toEqualTypeOf<Pet>()
      } else if (res.status === 404) {
        expectTypeOf(await res.json()).toEqualTypeOf<Problem>()
      }
    })
  })

  it('says nothing about a status the route did not declare', () => {
    typeOnly(async () => {
      const res = await client.pets({ id: 1 }).owner.get()

      // The wildcard `4xx` the route declares is deliberately not read: it would have to be typed against `number`,
      // which overlaps every literal code, and that would widen the narrowed members back into a union.
      if (res.status === 500) {
        expectTypeOf(await res.json()).toEqualTypeOf<never>()
      }
    })
  })

  it('types a path parameter from the params schema', () => {
    typeOnly(() => {
      expectTypeOf(client.pets).toBeCallableWith({ id: 1 })
      // @ts-expect-error -- the schema says the id is an integer
      client.pets({ id: 'one' })
    })
  })

  it('chains nested parameters, each typed on its own', () => {
    typeOnly(async () => {
      const res = await client.pets({ petID: 1 }).orders({ orderID: 'a' }).get()

      expectTypeOf(await res.json()).toEqualTypeOf<{ order: number }>()
    })
  })

  it('keeps a static segment reachable beside a parameterised one', () => {
    typeOnly(async () => {
      const res = await client.pets.search.get({ query: { q: 'rex' }, headers: { 'x-tenant': 't1' } })

      expectTypeOf(await res.json()).toEqualTypeOf<string[]>()
    })
  })

  it('rejects a segment the application does not declare', () => {
    typeOnly(() => {
      // @ts-expect-error -- no such path
      client.dogs.get()
    })
  })

  it('rejects a verb the path does not answer', () => {
    typeOnly(() => {
      // @ts-expect-error -- /pets/:id answers GET only
      client.pets({ id: 1 }).delete()
    })
  })
})

describe('the init argument', () => {
  it('disappears when the route needs nothing from it', () => {
    typeOnly(() => {
      expectTypeOf(client.pets.get).toBeCallableWith()
    })
  })

  it('requires a declared body', () => {
    typeOnly(() => {
      expectTypeOf(client.pets.post).toBeCallableWith({ body: { id: 1, name: 'Rex' } })
      // @ts-expect-error -- the body is declared, so it is required
      void client.pets.post()
    })
  })

  it('requires a declared query and headers', () => {
    typeOnly(() => {
      // @ts-expect-error -- both are declared by the route
      void client.pets.search.get()
      // @ts-expect-error -- the querystring schema says q is a string
      void client.pets.search.get({ query: { q: 1 }, headers: { 'x-tenant': 't1' } })
    })
  })

  it('takes RequestInit fields alongside', () => {
    typeOnly(() => {
      expectTypeOf(client.pets.get).toBeCallableWith({ signal: new AbortController().signal })
    })
  })
})

describe('the escape hatch', () => {
  it('addresses a route by method and path, params included', () => {
    typeOnly(async () => {
      const res = await client.$request('GET', '/pets/:id', { params: { id: 1 } })

      expectTypeOf(await res.json()).toEqualTypeOf<Pet>()
    })
  })

  it('rejects a path the method does not answer', () => {
    typeOnly(() => {
      // @ts-expect-error -- there is no POST /pets/:id
      void client.$request('POST', '/pets/:id', { params: { id: 1 } })
    })
  })
})

describe('what the client can be typed from', () => {
  it('accepts an application, a router, or the bare union', () => {
    typeOnly(async () => {
      const fromApp = brewer<App>('http://localhost')
      const fromRouter = brewer<typeof pets>('http://localhost')
      const fromUnion = brewer<RoutesOf<App>>('http://localhost')

      expectTypeOf(await (await fromApp.pets({ id: 1 }).get()).json()).toEqualTypeOf<Pet>()
      expectTypeOf(await (await fromRouter.pets({ id: 1 }).get()).json()).toEqualTypeOf<Pet>()
      expectTypeOf(await (await fromUnion.pets({ id: 1 }).get()).json()).toEqualTypeOf<Pet>()
    })
  })

  it('accepts a router whose routes were declared as separate statements and blended', () => {
    typeOnly(async () => {
      const owner = new Router('/tags')
      const list = owner.get('/').handler(() => [] as string[])
      const one = owner
        .get('/:name')
        .schema({ response: { 200: petSchema } })
        .handler(ctx => ctx.body())

      const blended = blend(list, one)
      const client = brewer<typeof blended>('http://localhost')

      expectTypeOf(await (await client.tags.get()).json()).toEqualTypeOf<string[]>()
      expectTypeOf(await (await client.tags({ name: 'x' }).get()).json()).toEqualTypeOf<Pet>()
    })
  })

  it('reads the surface off an application handed over as the target', () => {
    typeOnly(async () => {
      const client = brewer(app)

      expectTypeOf(await (await client.pets({ id: 1 }).get()).json()).toEqualTypeOf<Pet>()
      expectTypeOf(client.pets.post).toBeCallableWith({ body: { id: 1, name: 'Rex' } })
    })
  })

  it('types from one router while taking the application as the target', () => {
    typeOnly(async () => {
      const client = brewer<typeof pets>(app)

      expectTypeOf(await (await client.pets({ id: 1 }).get()).json()).toEqualTypeOf<Pet>()
    })
  })

  it('takes anything with a matching fetch, not only an application', () => {
    typeOnly(async () => {
      const stub: Fetchable = { fetch: async () => new Response(null) }
      const client = brewer<App>(stub)

      expectTypeOf(await (await client.pets({ id: 1 }).get()).json()).toEqualTypeOf<Pet>()
    })
  })
})
