import { Router, createWebApplication, blend } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { describe, expectTypeOf, it } from 'vitest'

import { testClient } from './index.js'

const petSchema = $t.Object({ id: $t.Integer(), name: $t.String() })
const problemSchema = $t.Object({ detail: $t.String() })

class Greeter {
  greet(name: string): string {
    return `hello ${name}`
  }
}

class Clock {
  now(): number {
    return 0
  }
}

const pets = new Router('/pets')
  .get('/')
  .handler(() => [] as Pet[])
  .post('/')
  .schema({ body: petSchema })
  .handler(() => ({ created: true }))
  .get('/:id')
  .schema({ params: $t.Object({ id: $t.Integer() }), response: { 200: petSchema, 404: problemSchema } })
  .handler(ctx => ctx.body())
  .get('/search')
  .schema({ querystring: $t.Object({ q: $t.String() }) })
  .handler(() => [] as string[])

const greet = new Router('/greet')
  .inject({ greeter: Greeter })
  .get('/:name')
  .handler((_ctx, deps) => ({ message: deps.greeter.greet('x') }))

const ticks = new Router('/ticks')
  .inject({ clock: Clock })
  .get('/')
  .handler((_ctx, deps) => ({ at: deps.clock.now() }))

const bare = new Router('/bare').get('/', () => ({ ok: true }))

const app = createWebApplication().mount(pets, greet)

type Pet = { id: number; name: string }
type Problem = { detail: string }

/**
 * Holds an assertion that is checked by the compiler and never run.
 *
 * These calls would stand an application up, and what is under test is the type of the call rather than its
 * result — so the body is built and dropped.
 */
function typeOnly(_assertions: () => unknown): void {}

describe('what a client can be built from', () => {
  it('types the routes of a single router', () => {
    typeOnly(async () => {
      const client = testClient(pets)

      expectTypeOf(await (await client.pets.get()).json()).toEqualTypeOf<Pet[]>()
    })
  })

  it('types the routes of every router in a list', () => {
    typeOnly(async () => {
      const client = testClient([pets, greet])

      expectTypeOf(await (await client.pets.get()).json()).toEqualTypeOf<Pet[]>()
      expectTypeOf(await (await client.greet({ name: 'ada' }).get()).json()).toEqualTypeOf<{ message: string }>()
    })
  })

  it('types the routes an application mounted', () => {
    typeOnly(async () => {
      const client = testClient(app)

      expectTypeOf(await (await client.pets.get()).json()).toEqualTypeOf<Pet[]>()
    })
  })

  it('rejects a segment nothing declares', () => {
    typeOnly(() => {
      const client = testClient(pets)

      // @ts-expect-error -- there is no /dogs
      client.dogs.get()
    })
  })

  it('rejects a verb the route does not answer', () => {
    typeOnly(() => {
      const client = testClient(pets)

      // @ts-expect-error -- /pets/:id answers GET only
      client.pets({ id: 1 }).delete()
    })
  })
})

describe('the request', () => {
  it('types a path parameter from the params schema', () => {
    typeOnly(() => {
      const client = testClient(pets)

      expectTypeOf(client.pets).toBeCallableWith({ id: 1 })
      // @ts-expect-error -- the schema says the id is an integer
      client.pets({ id: 'one' })
    })
  })

  it('requires a declared body and a declared query', () => {
    typeOnly(() => {
      const client = testClient(pets)

      expectTypeOf(client.pets.post).toBeCallableWith({ body: { id: 1, name: 'Rex' } })
      // @ts-expect-error -- the body is declared, so it is required
      void client.pets.post()
      // @ts-expect-error -- the querystring is declared, so it is required
      void client.pets.search.get()
    })
  })
})

describe('the response', () => {
  it('types the body from the status the caller checked', () => {
    typeOnly(async () => {
      const client = testClient(pets)
      const res = await client.pets({ id: 1 }).get()

      if (res.status === 200) {
        expectTypeOf(await res.json()).toEqualTypeOf<Pet>()
      } else if (res.status === 404) {
        expectTypeOf(await res.json()).toEqualTypeOf<Problem>()
      }
    })
  })

  it('leaves the status wide, so an undeclared code can still be asserted on', () => {
    typeOnly(async () => {
      const client = testClient(pets)
      const res = await client.pets({ id: 1 }).get()

      expectTypeOf(res.status).toEqualTypeOf<number>()
    })
  })

  it('types the body from the handler where no schema declares one', () => {
    typeOnly(async () => {
      const client = testClient(pets)

      expectTypeOf(await (await client.pets.get()).json()).toEqualTypeOf<Pet[]>()
    })
  })
})

describe('the inject option', () => {
  it('accepts a name the target declared', () => {
    typeOnly(() => {
      testClient(greet, { inject: { greeter: new Greeter() } })
      testClient(greet, { inject: { greeter: { greet: () => 'x' } } })
    })
  })

  it('rejects a name the target never declared', () => {
    typeOnly(() => {
      // @ts-expect-error -- the router injects "greeter", not "repository"
      testClient(greet, { inject: { repository: {} } })
    })
  })

  it('reaches every name across a list of routers', () => {
    typeOnly(() => {
      testClient([greet, ticks], { inject: { greeter: new Greeter(), clock: new Clock() } })
      // @ts-expect-error -- neither router injects "repository"
      testClient([greet, ticks], { inject: { repository: {} } })
    })
  })

  it('reaches the names of everything an application mounted', () => {
    typeOnly(() => {
      testClient(app, { inject: { greeter: new Greeter() } })
      // @ts-expect-error -- nothing the application mounted injects "repository"
      testClient(app, { inject: { repository: {} } })
    })
  })

  it('survives blending routers into one', () => {
    typeOnly(() => {
      const blended = blend(greet, ticks)

      testClient(blended, { inject: { greeter: new Greeter(), clock: new Clock() } })
    })
  })

  it('is empty for a target that injected nothing', () => {
    typeOnly(() => {
      testClient(bare, { inject: {} })
      // @ts-expect-error -- the router injects nothing at all
      testClient(bare, { inject: { greeter: new Greeter() } })
    })
  })
})

describe('the options an application cannot take', () => {
  it('rejects the ones only a built application would use', () => {
    typeOnly(() => {
      // @ts-expect-error -- the application already has its container
      testClient(app, { container: undefined as never })
      // @ts-expect-error -- the application has already been built
      testClient(app, { configure: () => {} })
    })
  })

  it('still takes the request init and a binding hook', () => {
    typeOnly(() => {
      testClient(app, { init: { headers: { 'x-tenant': 't1' } } })
      testClient(app, { bind: container => void container })
    })
  })
})

describe('the controls', () => {
  it('names the application, its container and the lifecycle', () => {
    typeOnly(async () => {
      const client = testClient(pets)

      expectTypeOf(client.$app).toEqualTypeOf<typeof client.$app>()
      expectTypeOf(client.$container.get).toBeFunction()
      expectTypeOf(await client.$fetch('/pets')).toEqualTypeOf<Response>()
      expectTypeOf(client.$ready()).toEqualTypeOf<Promise<void>>()
      expectTypeOf(client.$close()).toEqualTypeOf<Promise<void>>()
    })
  })
})
