import { Router, blend, type RouteDef, type RoutesOf } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { $t } from '@caffeinejs/std/schema'
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

const app = createWebApplication().mount(pets)

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
    // The guard that makes the structural copy safe: a field added to, or removed from, either side stops this
    // compiling.
    expectTypeOf<RouteDef>().toEqualTypeOf<RouteContract>()
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

  it('lets an optional path parameter be left out, and takes a wildcard as one string', () => {
    typeOnly(async () => {
      const tags = new Router('/tags').get('/:name?').handler(() => ({ tagged: true }))
      const files = new Router('/files').get('/*').handler(() => ({ file: true }))
      const client = brewer<typeof tags | typeof files>('http://localhost')

      expectTypeOf(client.tags).toBeCallableWith({})
      expectTypeOf(client.tags).toBeCallableWith({ name: 'cute' })
      expectTypeOf(await (await client.files({ '*': 'docs/a.pdf' }).get()).json()).toEqualTypeOf<{ file: boolean }>()
      // @ts-expect-error -- a wildcard is one string, slashes and all
      void client.files({ '*': ['docs', 'a.pdf'] })
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

  it('hides a segment named then, which the proxy never answers', () => {
    typeOnly(async () => {
      const flows = new Router('/flows').get('/then').handler(() => ({ next: true }))
      const client = brewer<typeof flows>('http://localhost')

      // @ts-expect-error -- a node answering `then` would be taken for a promise; `$request` reaches the segment
      void client.flows.then.get()
      expectTypeOf(await (await client.$request('GET', '/flows/then')).json()).toEqualTypeOf<{ next: boolean }>()
    })
  })

  it('offers QUERY as a verb, and hides a segment named query', () => {
    typeOnly(async () => {
      const logs = new Router('/logs')
        .query('/')
        .schema({ body: $t.Object({ term: $t.String() }) })
        .handler(() => [] as string[])
        .get('/query')
        .handler(() => ({ saved: true }))
      const client = brewer<typeof logs>('http://localhost')

      expectTypeOf(await (await client.logs.query({ body: { term: 'error' } })).json()).toEqualTypeOf<string[]>()
      expectTypeOf(await (await client.$request('QUERY', '/logs', { body: { term: 'error' } })).json()).toEqualTypeOf<
        string[]
      >()
      // @ts-expect-error -- `query` is a verb, so the segment named after it is reached through `$request`
      void client.logs.query.get()
      expectTypeOf(await (await client.$request('GET', '/logs/query')).json()).toEqualTypeOf<{ saved: boolean }>()
    })
  })

  it('offers only the methods the proxy has a verb for', () => {
    typeOnly(async () => {
      const dav = new Router('/dav').route('PROPFIND', '/').handler(() => ({ props: true }))
      const client = brewer<typeof dav>('http://localhost')

      // @ts-expect-error -- the proxy would read `propfind` as a segment; `$request` sends the method
      void client.dav.propfind()
      expectTypeOf(await (await client.$request('PROPFIND', '/dav')).json()).toEqualTypeOf<{ props: boolean }>()
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

  it('may be left out when nothing the query or the headers declare is required', () => {
    typeOnly(() => {
      const list = new Router('/list')
        .get('/')
        .schema({ querystring: $t.Object({ limit: $t.Optional($t.Integer()), cursor: $t.Optional($t.String()) }) })
        .handler(() => [] as string[])
        .get('/fresh')
        .schema({ headers: $t.Object({ 'if-none-match': $t.Optional($t.String()) }) })
        .handler(() => ({ fresh: true }))
      const client = brewer<typeof list>('http://localhost')

      expectTypeOf(client.list.get).toBeCallableWith()
      expectTypeOf(client.list.get).toBeCallableWith({ query: { limit: 10 } })
      expectTypeOf(client.list.fresh.get).toBeCallableWith()
      // @ts-expect-error -- the querystring schema says limit is an integer
      void client.list.get({ query: { limit: 'ten' } })
    })
  })

  it('takes headers the route did not declare beside the ones it did', () => {
    typeOnly(() => {
      const counted = new Router('/counted')
        .get('/')
        .schema({ headers: $t.Object({ 'x-count': $t.Integer() }) })
        .handler(() => ({ counted: true }))
      const countedClient = brewer<typeof counted>('http://localhost')

      // Called directly rather than through `toBeCallableWith`, which infers its argument and so never checks a
      // literal for properties the parameter does not have.
      void client.pets.search.get({ query: { q: 'rex' }, headers: { 'x-tenant': 't1', authorization: 'Bearer abc' } })
      void countedClient.counted.get({ headers: { 'x-count': 5, authorization: 'Bearer abc' } })
      // @ts-expect-error -- the declared x-tenant is still required
      void client.pets.search.get({ query: { q: 'rex' }, headers: { authorization: 'Bearer abc' } })
    })
  })

  it('takes RequestInit fields alongside', () => {
    typeOnly(() => {
      expectTypeOf(client.pets.get).toBeCallableWith({ signal: new AbortController().signal })
    })
  })
})

describe('the body', () => {
  const uploads = new Router('/uploads')
    .post('/profile')
    .schema({ body: $t.Object({ caption: $t.String(), avatar: $t.File(), photos: $t.Optional($t.Files()) }) })
    .handler(() => ({ saved: true }))
    .post('/album')
    .schema({ body: $t.Object({ photos: $t.Files() }) })
    .handler(() => ({ saved: true }))
    .post('/single')
    .schema({ body: $t.File() })
    .handler(() => ({ saved: true }))
    .post('/batch')
    .schema({ body: $t.Files() })
    .handler(() => ({ saved: true }))
  const forms = new Router('/forms')
    .post('/adoptions')
    .schema({ body: $t.Object({ name: $t.String(), age: $t.Integer() }) })
    .handler(() => ({ adopted: true }))
    .post('/litter')
    .schema({ body: $t.Array(petSchema) })
    .handler(() => ({ adopted: true }))
    .post('/notes')
    .schema({ body: $t.Object({ meta: $t.Any() }) })
    .handler(() => ({ noted: true }))
    .post('/attachments')
    .schema({
      body: $t.Object({ link: $t.Union([$t.File(), $t.String()]), cover: $t.Union([$t.File(), $t.Null()]) }),
    })
    .handler(() => ({ attached: true }))
    .post('/changes')
    .schema({ body: $t.Union([$t.Object({ name: $t.String() }), $t.Object({ avatar: $t.File() })]) })
    .handler(() => ({ changed: true }))
    .post('/anything')
    .handler(() => ({ taken: true }))
  const bodies = blend(uploads, forms)
  const client = brewer<typeof bodies>('http://localhost')

  it('takes a FormData for a body that is a file or holds one, and nothing else', () => {
    typeOnly(() => {
      const avatar = new File(['jpeg'], 'rex.jpg', { type: 'image/jpeg' })

      void client.uploads.profile.post({ body: new FormData() })
      void client.uploads.album.post({ body: new FormData() })
      void client.uploads.single.post({ body: new FormData() })
      void client.uploads.batch.post({ body: new FormData() })
      // @ts-expect-error -- an object goes as JSON, where a file arrives as {}
      void client.uploads.profile.post({ body: { caption: 'Rex', avatar } })
      // @ts-expect-error -- the server reads a file body as a multipart form, so a bare file is not one
      void client.uploads.single.post({ body: avatar })
    })
  })

  it('takes the declared object, or a URLSearchParams sent as a form, for a plain-object body', () => {
    typeOnly(() => {
      void client.forms.adoptions.post({ body: { name: 'Rex', age: 3 } })
      void client.forms.adoptions.post({ body: new URLSearchParams({ name: 'Rex', age: '3' }) })
      // @ts-expect-error -- the server reads no multipart form into a declared body
      void client.forms.adoptions.post({ body: new FormData() })
      // @ts-expect-error -- the schema says age is an integer
      void client.forms.adoptions.post({ body: { name: 'Rex', age: 'three' } })
    })
  })

  it('keeps an array body as declared, since a form cannot carry one', () => {
    typeOnly(() => {
      void client.forms.litter.post({ body: [{ id: 1, name: 'Rex' }] })
      // @ts-expect-error -- a form has no way to carry a list of objects
      void client.forms.litter.post({ body: new URLSearchParams() })
    })
  })

  it('reads a field typed any as no file, so the route keeps taking JSON', () => {
    typeOnly(() => {
      void client.forms.notes.post({ body: { meta: { tags: ['a'] } } })
    })
  })

  // The server takes a field for a file only when it is one, or a list of them, so a union leaves the route on JSON.
  it('reads a field that may be a file or something else, null included, as JSON', () => {
    typeOnly(() => {
      void client.forms.attachments.post({ body: { link: 'https://example.com/rex.jpg', cover: null } })
      // @ts-expect-error -- the route reads JSON, so a multipart form never reaches its schema
      void client.forms.attachments.post({ body: new FormData() })
    })
  })

  it('reads a union body as JSON, whatever its members hold', () => {
    typeOnly(() => {
      void client.forms.changes.post({ body: { name: 'Rex' } })
      // @ts-expect-error -- the server reads no multipart form into a union body
      void client.forms.changes.post({ body: new FormData() })
    })
  })

  it('leaves an undeclared body optional, and takes anything for it', () => {
    typeOnly(() => {
      expectTypeOf(client.forms.anything.post).toBeCallableWith()
      void client.forms.anything.post({ body: new Blob(['x']) })
      void client.forms.anything.post({ body: { any: 'thing' } })
    })
  })

  it('applies the same rules through the escape hatch', () => {
    typeOnly(() => {
      void client.$request('POST', '/uploads/profile', { body: new FormData() })
      void client.$request('POST', '/forms/adoptions', { body: new URLSearchParams({ name: 'Rex', age: '3' }) })
      // @ts-expect-error -- an object goes as JSON, where a file arrives as {}
      void client.$request('POST', '/uploads/profile', { body: { caption: 'Rex' } })
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

  it('lets an optional path parameter be left out, and takes no params for a path without any', () => {
    typeOnly(() => {
      const tags = new Router('/tags').get('/:name?').handler(() => [] as string[])
      const tagged = brewer<typeof tags>('http://localhost')

      void tagged.$request('GET', '/tags/:name?')
      void tagged.$request('GET', '/tags/:name?', { params: { name: 'cute' } })
      // @ts-expect-error -- /pets declares no path parameter
      void client.$request('GET', '/pets', { params: { id: 1 } })
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
