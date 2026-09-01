import { describe, expectTypeOf, it } from 'vitest'
import { $i, type Provider } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std'
import { Router, blend, createWebApplication, fst } from '../index.js'
import type { PathParams, RoutesOf } from '../routing/programmatic/types.js'

class Greeter { }
class Audit { }
abstract class Validator { }

describe('path parameters', () => {
  it('reads them off a literal path', () => {
    expectTypeOf<PathParams<'/pets'>>().toEqualTypeOf<Record<never, never>>()
    expectTypeOf<PathParams<'/pets/:id'>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<PathParams<'/pets/:petID/orders/:orderID'>>()
      .toEqualTypeOf<{ petID: string } & { orderID: string }>()
  })

  it('treats a matching constraint as part of the pattern, not the name', () => {
    expectTypeOf<PathParams<'/pets/:id(^\\d+)'>>().toEqualTypeOf<{ id: string }>()
  })

  it('makes an optional parameter optional', () => {
    expectTypeOf<PathParams<'/pets/:id?'>>().toEqualTypeOf<{ id?: string }>()
  })

  it('falls back to an open record for a path that is not a literal', () => {
    expectTypeOf<PathParams<string>>().toEqualTypeOf<Record<string, string>>()
  })
})

describe('handler context', () => {
  it('types the parameters from the path when no schema declares them', () => {
    const router = new Router('/pets')

    router.get('/:id').handler(ctx => {
      expectTypeOf(ctx.req.param()).toEqualTypeOf<{ id: string }>()
      return ctx.body()
    })
  })

  it('takes the group path into account', () => {
    const router = new Router('/pets/:petID')

    router.get('/orders/:orderID').handler(ctx => {
      expectTypeOf(ctx.req.param()).toEqualTypeOf<{ petID: string, orderID: string }>()
      return ctx.body()
    })
  })

  it('lets a declared schema win over the path', () => {
    const router = new Router('/pets')

    router
      .get('/:id')
      .schema({ params: $t.Object({ id: $t.Integer() }) })
      .handler(ctx => {
        expectTypeOf(ctx.req.param().id).toEqualTypeOf<number>()
        return ctx.body()
      })
  })

  it('types the query, headers and body from their schemas', () => {
    const router = new Router('/orders')

    router
      .post('/')
      .schema({
        querystring: $t.Object({ page: $t.Integer() }),
        headers: $t.Object({ 'x-tenant': $t.String() }),
        body: $t.Object({ quantity: $t.Integer() }),
      })
      .handler(ctx => {
        expectTypeOf(ctx.req.query().page).toEqualTypeOf<number>()
        expectTypeOf(ctx.req.header()['x-tenant']).toEqualTypeOf<string>()
        expectTypeOf(ctx.req.body().quantity).toEqualTypeOf<number>()
        return ctx.body()
      })
  })
})

describe('injected dependencies', () => {
  it('is undefined when nothing was injected', () => {
    const router = new Router('/plain')

    router.get('/').handler((_ctx, deps) => {
      expectTypeOf(deps).toEqualTypeOf<undefined>()
      return null
    })
  })

  it('carries the resolved type of each injection helper', () => {
    const router = new Router('/deps')

    router
      .get('/')
      .inject({ greeter: Greeter, audit: $i.optional(Audit), all: $i.allOf(Validator) })
      .handler((_ctx, deps) => {
        expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
        expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
        expectTypeOf(deps.all).toEqualTypeOf<Validator[]>()
        return null
      })
  })

  it('shows a group injection to its routes', () => {
    const router = new Router('/group').inject({ greeter: Greeter })

    router.get('/').handler((_ctx, deps) => {
      expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
      return null
    })
  })

  it('merges a route injection over the group one, letting a name be re-bound', () => {
    const router = new Router('/merged').inject({ greeter: Greeter, audit: Audit })

    router.get('/').inject({ audit: $i.optional(Audit) }).handler((_ctx, deps) => {
      expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
      expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
      return null
    })
  })

  it('passes a group injection down into a nested group', () => {
    const router = new Router('/outer').inject({ greeter: Greeter })

    router.group('/inner', inner => {
      inner.inject({ audit: Audit }).get('/:id').handler((ctx, deps) => {
        expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
        expectTypeOf(deps.audit).toEqualTypeOf<Audit>()
        expectTypeOf(ctx.req.param()).toEqualTypeOf<{ id: string }>()
        return null
      })
    })
  })
})

describe('a spec built from the helpers handed to inject', () => {
  it('carries the same resolved types the spec form does', () => {
    const router = new Router('/deps')

    router
      .get('/')
      .inject(i => ({ greeter: Greeter, audit: i.optional(Audit), all: i.allOf(Validator) }))
      .handler((_ctx, deps) => {
        expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
        expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
        expectTypeOf(deps.all).toEqualTypeOf<Validator[]>()
        return null
      })
  })

  it('shows a group injection to its routes', () => {
    const router = new Router('/group').inject(i => ({ greeter: Greeter, audit: i.optional(Audit) }))

    router.get('/').handler((_ctx, deps) => {
      expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
      expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
      return null
    })
  })

  it('merges over the group one whichever form each was written in', () => {
    const router = new Router('/merged').inject(i => ({ greeter: Greeter, audit: i.allOf(Audit) }))

    router.get('/').inject({ audit: $i.optional(Audit) }).handler((_ctx, deps) => {
      expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
      expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
      return null
    })

    const other = new Router('/other').inject({ greeter: Greeter })

    other.get('/').inject(i => ({ greeter: i.provide(Greeter) })).handler((_ctx, deps) => {
      expectTypeOf(deps.greeter).toEqualTypeOf<Provider<Greeter>>()
      return null
    })
  })

  it('carries a constant, which no container binding backs', () => {
    const router = new Router('/const').inject(i => ({ label: i.just('pets') }))

    router.get('/').handler((_ctx, deps) => {
      expectTypeOf(deps.label).toEqualTypeOf<string>()
      return null
    })
  })

  it('passes a group callback down into a nested group', () => {
    const router = new Router('/outer').inject(i => ({ all: i.allOf(Validator) }))

    router.group('/inner', inner => {
      inner.inject(i => ({ audit: i.optional(Audit) })).get('/').handler((_ctx, deps) => {
        expectTypeOf(deps.all).toEqualTypeOf<Validator[]>()
        expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
        return null
      })
    })
  })
})

describe('route accumulation', () => {
  const petSchema = $t.Object({ id: $t.String(), name: $t.String() })

  it('is empty for a router with no routes', () => {
    expectTypeOf<RoutesOf<Router<undefined, '/pets'>>>().toEqualTypeOf<never>()
  })

  it('carries one descriptor per route of a chained declaration', () => {
    const pets = new Router('/pets')
      .get('/').handler(() => [] as Array<{ id: string }>)
      .post('/:id').schema({ params: $t.Object({ id: $t.Integer() }), body: petSchema })
      .handler(() => 1)

    type Routes = RoutesOf<typeof pets>

    expectTypeOf<Extract<Routes, { method: 'GET' }>['path']>().toEqualTypeOf<'/pets'>()
    expectTypeOf<Extract<Routes, { method: 'GET' }>['output']>().toEqualTypeOf<Array<{ id: string }>>()

    type Created = Extract<Routes, { method: 'POST' }>
    expectTypeOf<Created['path']>().toEqualTypeOf<'/pets/:id'>()
    expectTypeOf<Created['params']>().toEqualTypeOf<{ id: number }>()
    expectTypeOf<Created['body']>().toEqualTypeOf<{ id: string, name: string }>()
    expectTypeOf<Created['output']>().toEqualTypeOf<number>()
  })

  it('takes the output from the response schema over the handler return', () => {
    const pets = new Router('/pets')
      .get('/:id')
      .schema({ response: { 200: petSchema } })
      .handler(() => 'not the contract')

    expectTypeOf<RoutesOf<typeof pets>['output']>().toEqualTypeOf<{ id: string, name: string }>()
  })

  it('reports unknown for a handler that answered through the context', () => {
    const pets = new Router('/pets')
      .get('/:id')
      .handler(ctx => ctx.body({ id: 1 }))

    expectTypeOf<RoutesOf<typeof pets>['output']>().toEqualTypeOf<unknown>()
  })

  it('unwraps an async handler', () => {
    const pets = new Router('/pets')
      .get('/:id')
      .handler(async () => ({ id: 'a' }))

    expectTypeOf<RoutesOf<typeof pets>['output']>().toEqualTypeOf<{ id: string }>()
  })

  it('folds a nested group in, with its full path', () => {
    const api = new Router('/api')
      .get('/health').handler(() => ({ ok: true }))
      .group('/v1', v1 => v1.get('/pets').handler(() => []))

    type Routes = RoutesOf<typeof api>

    expectTypeOf<Routes['path']>().toEqualTypeOf<'/api/health' | '/api/v1/pets'>()
  })

  it('folds a mounted router in, re-based under the host path', () => {
    const inner = new Router('/inner').get('/ping').handler(() => ({ pong: true }))

    const outer = new Router('/outer')
      .mount(inner)
      .mount('/v2', inner)

    expectTypeOf<RoutesOf<typeof outer>['path']>()
      .toEqualTypeOf<'/outer/inner/ping' | '/outer/v2/inner/ping'>()
  })

  it('folds every mounted router into the application', () => {
    const pets = new Router('/pets').get('/').handler(() => [])
    const orders = new Router('/orders').post('/').handler(() => ({ id: 1 }))

    const app = createWebApplication().build().mount(pets, orders)

    type Routes = RoutesOf<typeof app>

    expectTypeOf<Routes['path']>().toEqualTypeOf<'/pets' | '/orders'>()
    expectTypeOf<Extract<Routes, { method: 'POST' }>['output']>().toEqualTypeOf<{ id: number }>()
  })

  it('accumulates nothing on the variable a statement-style declaration opened from', () => {
    const pets = new Router('/pets')
    pets.get('/').handler(() => [])

    expectTypeOf<RoutesOf<typeof pets>>().toEqualTypeOf<never>()
  })
})

describe('a handler written inline on the verb', () => {
  it('closes the route and hands the group back, so the next route chains off it', () => {
    const pets = new Router('/pets')
      .get('/', () => [{ id: 1 }])
      .post('/:id', () => ({ created: true }))

    type Routes = RoutesOf<typeof pets>

    expectTypeOf<Routes['path']>().toEqualTypeOf<'/pets' | '/pets/:id'>()
    expectTypeOf<Extract<Routes, { method: 'GET' }>['output']>().toEqualTypeOf<{ id: number }[]>()
    expectTypeOf<Extract<Routes, { method: 'POST' }>['output']>().toEqualTypeOf<{ created: boolean }>()
  })

  it('types the context from the path when no schema is declared', () => {
    new Router('/pets').get('/:id', ctx => {
      expectTypeOf(ctx.req.param()).toEqualTypeOf<{ id: string }>()
      return null
    })
  })

  it('types the context from a schema declared before it', () => {
    const pets = new Router('/pets').post(
      '/:id',
      {
        params: $t.Object({ id: $t.Integer() }),
        body: $t.Object({ name: $t.String() }),
        querystring: $t.Object({ dry: $t.Boolean() }),
      },
      ctx => {
        expectTypeOf(ctx.req.param()).toEqualTypeOf<{ id: number }>()
        expectTypeOf(ctx.req.body()).toEqualTypeOf<{ name: string }>()
        expectTypeOf(ctx.req.query()).toEqualTypeOf<{ dry: boolean }>()
        return ctx.req.body()
      },
    )

    type Routes = RoutesOf<typeof pets>

    expectTypeOf<Routes['params']>().toEqualTypeOf<{ id: number }>()
    expectTypeOf<Routes['body']>().toEqualTypeOf<{ name: string }>()
    expectTypeOf<Routes['query']>().toEqualTypeOf<{ dry: boolean }>()
    expectTypeOf<Routes['output']>().toEqualTypeOf<{ name: string }>()
  })

  it('answers with the declared response schema over the handler return', () => {
    const pets = new Router('/pets')
      .get('/', { response: { 200: $t.Object({ id: $t.Integer() }) } }, () => 'ignored')

    expectTypeOf<RoutesOf<typeof pets>['output']>().toEqualTypeOf<{ id: number }>()
  })

  it('hands the group dependencies over as the second argument', () => {
    new Router('/pets')
      .inject({ greeter: Greeter, audit: $i.optional(Audit) })
      .get('/', (_ctx, deps) => {
        expectTypeOf(deps.greeter).toEqualTypeOf<Greeter>()
        expectTypeOf(deps.audit).toEqualTypeOf<Audit | undefined>()
        return null
      })
  })

  it('hands undefined over when nothing was injected', () => {
    new Router('/pets').get('/', (_ctx, deps) => {
      expectTypeOf(deps).toEqualTypeOf<undefined>()
      return null
    })
  })

  it('carries the method union of an explicit route', () => {
    const pets = new Router('/pets').route(['GET', 'POST'], '/', () => null)

    expectTypeOf<RoutesOf<typeof pets>['method']>().toEqualTypeOf<'GET' | 'POST'>()
  })

  it('mixes with chained routes in one declaration', () => {
    const pets = new Router('/pets')
      .get('/', () => [])
      .put('/:id')
      .schema({ params: $t.Object({ id: $t.Integer() }) })
      .name('replace')
      .handler(ctx => ({ id: ctx.req.param().id }))
      .delete('/:id', () => null)

    expectTypeOf<RoutesOf<typeof pets>['method']>().toEqualTypeOf<'GET' | 'PUT' | 'DELETE'>()
  })

  it('still opens a chain when no handler is given', () => {
    const chain = new Router('/pets').get('/:id')

    expectTypeOf(chain.schema).toBeFunction()
    expectTypeOf(chain.handler).toBeFunction()
  })
})

describe('blend', () => {
  it('unions the routes of statement-style declarations on one router', () => {
    const pets = new Router('/pets')
    const list = pets.get('/').handler(() => [{ id: 1 }])
    const add = pets.post('/:kind').handler(() => ({ id: 1 }))

    const blended = blend(list, add)

    type Routes = RoutesOf<typeof blended>

    expectTypeOf<Routes['path']>().toEqualTypeOf<'/pets' | '/pets/:kind'>()
    expectTypeOf<Routes['method']>().toEqualTypeOf<'GET' | 'POST'>()
    expectTypeOf<Extract<Routes, { method: 'GET' }>['output']>().toEqualTypeOf<{ id: number }[]>()
    expectTypeOf<Extract<Routes, { method: 'POST' }>['params']>().toEqualTypeOf<{ kind: string }>()
  })

  it('unions the routes of independent routers, leaving their paths alone', () => {
    const pets = new Router('/pets').get('/').handler(() => [])
    const orders = new Router('/orders').post('/').handler(() => ({ id: 1 }))

    const blended = blend(pets, orders)

    expectTypeOf<RoutesOf<typeof blended>['path']>().toEqualTypeOf<'/pets' | '/orders'>()
  })

  it('is unchanged by naming the router the routes were opened from', () => {
    const pets = new Router('/pets')
    const list = pets.get('/').handler(() => [])

    const blended = blend(pets, list)

    expectTypeOf<RoutesOf<typeof blended>['path']>().toEqualTypeOf<'/pets'>()
  })

  it('nests and mounts like any other router', () => {
    const pets = new Router('/pets')
    const list = pets.get('/').handler(() => [])
    const add = pets.post('/').handler(() => ({ id: 1 }))

    const app = createWebApplication().build().mount(blend(list, add))

    expectTypeOf<RoutesOf<typeof app>['method']>().toEqualTypeOf<'GET' | 'POST'>()
  })
})

describe('mount', () => {
  it('takes several routers at once, and re-bases them all under a path', () => {
    const pets = new Router('/pets').get('/').handler(() => [])
    const orders = new Router('/orders').get('/').handler(() => [])

    const api = new Router('/api').mount('/v1', pets, orders)

    expectTypeOf<RoutesOf<typeof api>['path']>().toEqualTypeOf<'/api/v1/pets' | '/api/v1/orders'>()
  })

  it('folds statement-style routes into an application', () => {
    const pets = new Router('/pets')
    const list = pets.get('/').handler(() => [])
    const add = pets.post('/').handler(() => ({ id: 1 }))

    const app = createWebApplication().build().mount(list, add)

    expectTypeOf<RoutesOf<typeof app>['method']>().toEqualTypeOf<'GET' | 'POST'>()
  })
})

describe('fst options', () => {
  it('accepts what Fastify accepts', () => {
    expectTypeOf(fst).toBeCallableWith({ attachValidation: true })
    expectTypeOf(fst).toBeCallableWith({ logLevel: 'debug' })
    expectTypeOf(fst).toBeCallableWith({ compress: false })
  })

  it('rejects the keys the router owns', () => {
    // `config` is the dangerous one: it carries what the handler reads to apply status, headers and auth.
    // @ts-expect-error -- config belongs to the adapter
    fst({ config: { caffeine: undefined } })
    // @ts-expect-error -- the verb and the path decide these
    fst({ method: 'GET', url: '/nope' })
    // @ts-expect-error -- declared with .schema()
    fst({ schema: {} })
    // @ts-expect-error -- declared with .handler()
    fst({ handler: () => undefined })
    // @ts-expect-error -- declared with .bodyLimit()
    fst({ bodyLimit: 10 })
    // @ts-expect-error -- declared with .timeout()
    fst({ handlerTimeout: 10 })
  })
})
