import { $t } from '@caffeinejs/application/schema'
import { Responder, Router, blend, type RouteDef, type RoutesOf } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { describe, expectTypeOf, it } from 'vitest'

import type { Authenticator } from '../authenticator.js'
import { brewer, type Fetchable } from '../brewer.js'
import type { RouteContract } from '../contract.js'
import type { FormDataOf } from '../form.js'
import type { Interceptor } from '../interceptor.js'
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

  // A route that answers with a `Response`, a stream or bytes sends them as they are, and a string goes out as text:
  // `json()` would reject, or parse something else, so it is not typed as what the handler returned.
  it('types json() only for a body that is JSON, and leaves it unknown for text, bytes, streams and Responses', () => {
    typeOnly(async () => {
      const files = new Router('/files')
        .get('/response')
        .handler(() => new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/pdf' } }))
        .get('/stream')
        .handler(() => new ReadableStream<Uint8Array>())
        .get('/bytes')
        .handler(() => new Uint8Array([1, 2]))
        .get('/text')
        .handler(() => 'plain text')
      const client = brewer<typeof files>('http://localhost')

      expectTypeOf(await (await client.files.response.get()).json()).toEqualTypeOf<unknown>()
      expectTypeOf(await (await client.files.stream.get()).json()).toEqualTypeOf<unknown>()
      expectTypeOf(await (await client.files.bytes.get()).json()).toEqualTypeOf<unknown>()
      expectTypeOf(await (await client.files.text.get()).json()).toEqualTypeOf<unknown>()
      expectTypeOf(await (await client.files.response.get()).blob()).toEqualTypeOf<Blob>()
      expectTypeOf(await (await client.files.text.get()).text()).toEqualTypeOf<string>()
    })
  })

  // The server encodes any other value as JSON, a class instance with methods included: only its data is sent.
  it('keeps json() typed for an object the server encodes, methods or not, and unknown for a responder', () => {
    typeOnly(async () => {
      class Kennel {
        constructor(readonly id: number) {}

        label(): string {
          return `kennel ${this.id}`
        }
      }
      class Page extends Responder {
        respond(): string {
          return '<p>Rex</p>'
        }
      }
      const kennels = new Router('/kennels')
        .get('/entity')
        .handler(() => new Kennel(1))
        .get('/page')
        .handler(() => new Page())
        .get('/loose')
        .handler(() => JSON.parse('{}'))
      const client = brewer<typeof kennels>('http://localhost')

      expectTypeOf(await (await client.kennels.entity.get()).json()).toEqualTypeOf<Kennel>()
      expectTypeOf(await (await client.kennels.page.get()).json()).toEqualTypeOf<unknown>()
      expectTypeOf(await (await client.kennels.loose.get()).json()).toBeAny()
    })
  })

  it('leaves json() unknown for a file the route declares, and types the error body beside it', () => {
    typeOnly(async () => {
      const reports = new Router('/reports')
        .get('/:id')
        .schema({ params: $t.Object({ id: $t.Integer() }), response: { 200: $t.File(), 404: problemSchema } })
        .handler(ctx => ctx.notFound({ detail: 'no such report' }))
      const client = brewer<typeof reports>('http://localhost')

      const res = await client.reports({ id: 1 }).get()

      if (res.status === 200) {
        expectTypeOf(await res.json()).toEqualTypeOf<unknown>()
        expectTypeOf(await res.bytes()).toEqualTypeOf<Uint8Array<ArrayBuffer>>()
      } else if (res.status === 404) {
        expectTypeOf(await res.json()).toEqualTypeOf<Problem>()
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

  it('keeps the name $request at the root for the escape hatch, and offers it as a segment further down', () => {
    typeOnly(async () => {
      const hatch = new Router('/$request').get('/').handler(() => ({ top: true }))
      const api = new Router('/api').get('/$request').handler(() => ({ nested: true }))
      const surface = blend(hatch, api)
      const client = brewer<typeof surface>('http://localhost')

      // @ts-expect-error -- at the root, `$request` is the escape hatch, which reaches the segment by its path
      void client.$request.get()
      expectTypeOf(await (await client.$request('GET', '/$request')).json()).toEqualTypeOf<{ top: boolean }>()
      expectTypeOf(await (await client.api.$request.get()).json()).toEqualTypeOf<{ nested: boolean }>()
    })
  })

  it('keeps the names of the file helpers at the root too, and offers them as segments further down', () => {
    typeOnly(async () => {
      const forms = new Router('/$formData').get('/').handler(() => ({ top: true }))
      const api = new Router('/api').get('/$file').handler(() => ({ nested: true }))
      const surface = blend(forms, api)
      const client = brewer<typeof surface>('http://localhost')
      const res = new Response('x')

      // @ts-expect-error -- at the root, `$formData` builds a form; `$request` reaches the segment by its path
      void client.$formData.get()
      expectTypeOf(client.$formData({ caption: 'Rex' })).toEqualTypeOf<FormDataOf<{ caption: string }>>()
      expectTypeOf(await client.$file(res)).toEqualTypeOf<File>()
      expectTypeOf(client.$filename(res)).toEqualTypeOf<string | undefined>()
      expectTypeOf(client.$progress(() => undefined)).toEqualTypeOf<TransformStream<Uint8Array, Uint8Array>>()
      expectTypeOf(await (await client.$request('GET', '/$formData')).json()).toEqualTypeOf<{ top: boolean }>()
      expectTypeOf(await (await client.api.$file.get()).json()).toEqualTypeOf<{ nested: boolean }>()
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
    .post('/swaps')
    .schema({
      body: $t.Union([
        $t.Object({ kind: $t.Literal('a'), avatar: $t.File() }),
        $t.Object({ kind: $t.Literal('b'), avatar: $t.File() }),
      ]),
    })
    .handler(() => ({ swapped: true }))
    .post('/scans')
    .schema({ body: $t.Object({ pages: $t.Union([$t.File(), $t.Files()]) }) })
    .handler(() => ({ scanned: true }))
    .post('/scan')
    .schema({ body: $t.Union([$t.File(), $t.Files()]) })
    .handler(() => ({ scanned: true }))
    .post('/owners')
    .schema({ body: $t.Object({ name: $t.String(), owner: $t.Object({ id: $t.Integer() }) }) })
    .handler(() => ({ owned: true }))
    .post('/rows')
    .schema({ body: $t.Object({ rows: $t.Array($t.Object({ id: $t.Integer() })) }) })
    .handler(() => ({ stored: true }))
    .post('/shirts')
    .schema({ body: $t.Object({ size: $t.String(), tags: $t.Optional($t.Array($t.String())) }) })
    .handler(() => ({ ordered: true }))
    .post('/settings')
    .schema({ body: $t.Record($t.String(), $t.String()) })
    .handler(() => ({ saved: true }))
    .post('/anything')
    .handler(() => ({ taken: true }))
  const bodies = blend(uploads, forms)
  const client = brewer<typeof bodies>('http://localhost')

  // A FormData carries no types, so one built by `formData` remembers its fields for the call to check.
  it('checks the fields of a form built with formData against the upload the route declares', () => {
    typeOnly(() => {
      const avatar = new File(['jpeg'], 'rex.jpg', { type: 'image/jpeg' })

      void client.uploads.profile.post({ body: client.$formData({ caption: 'Rex', avatar }) })
      void client.uploads.profile.post({ body: client.$formData({ caption: 'Rex', avatar, photos: [avatar, avatar] }) })
      void client.$request('POST', '/uploads/profile', { body: client.$formData({ caption: 'Rex', avatar }) })
      const built = client.$formData({ caption: 'Rex', avatar })
      void client.uploads.profile.post({ body: built })
      // @ts-expect-error -- the avatar is required
      void client.uploads.profile.post({ body: client.$formData({ caption: 'Rex' }) })
      // @ts-expect-error -- a field the route does not declare, which the server would take, unvalidated
      void client.uploads.profile.post({ body: client.$formData({ caption: 'Rex', avatar, phtos: [avatar] }) })
      // @ts-expect-error -- the caption is text
      void client.uploads.profile.post({ body: client.$formData({ caption: 7, avatar }) })
      // @ts-expect-error -- a Blob carries no name, where the route declares a file
      void client.uploads.profile.post({ body: client.$formData({ caption: 'Rex', avatar: new Blob(['jpeg']) }) })
      // @ts-expect-error -- checked through the escape hatch too
      void client.$request('POST', '/uploads/profile', { body: client.$formData({ caption: 'Rex' }) })
      // @ts-expect-error -- a form has no way to carry a nested object
      void client.$formData({ owner: { id: 1 } })
    })
  })

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

  // A form carries text, which the server coerces to the declared numbers and booleans, and a list as a repeated key.
  it('takes a URLSearchParams only for an object a form can carry', () => {
    typeOnly(() => {
      void client.forms.shirts.post({
        body: new URLSearchParams([
          ['size', 'L'],
          ['tags', 'red'],
          ['tags', 'cotton'],
        ]),
      })
      void client.forms.settings.post({ body: new URLSearchParams({ theme: 'dark' }) })
      void client.forms.owners.post({ body: { name: 'Rex', owner: { id: 1 } } })
      // @ts-expect-error -- a form has no way to carry a nested object
      void client.forms.owners.post({ body: new URLSearchParams() })
      // @ts-expect-error -- nor a list of objects
      void client.forms.rows.post({ body: new URLSearchParams() })
      // @ts-expect-error -- nor a union body, which the server reads as JSON
      void client.forms.changes.post({ body: new URLSearchParams() })
    })
  })

  it('still refuses a key the object does not declare, one URLSearchParams has included', () => {
    typeOnly(() => {
      void client.forms.shirts.post({ body: { size: 'L' } })
      // @ts-expect-error -- size is a member of URLSearchParams, and no field of this body
      void client.forms.adoptions.post({ body: { name: 'Rex', age: 3, size: 1 } })
      // @ts-expect-error -- sort, likewise, through the escape hatch too
      void client.$request('POST', '/forms/adoptions', { body: { name: 'Rex', age: 3, sort: () => undefined } })
    })
  })

  it('reads a field typed any as no file, so the route keeps taking JSON', () => {
    typeOnly(() => {
      void client.forms.notes.post({ body: { meta: { tags: ['a'] } } })
    })
  })

  // The server takes a field for a file only when it is one, or a list of them, so a union leaves the route on JSON:
  // with another type, null included, and with a list of files alike.
  it('reads a field that may be a file or something else, null and a list of files included, as JSON', () => {
    typeOnly(() => {
      void client.forms.attachments.post({ body: { link: 'https://example.com/rex.jpg', cover: null } })
      void client.forms.scans.post({ body: { pages: [] } })
      // @ts-expect-error -- the route reads JSON, so a multipart form never reaches its schema
      void client.forms.attachments.post({ body: new FormData() })
      // @ts-expect-error -- nor for a field that is a file or a list of files
      void client.forms.scans.post({ body: new FormData() })
    })
  })

  // The server looks for a file in the body and in its own properties, never inside a union.
  it('reads a union body as JSON, whatever its members hold', () => {
    typeOnly(() => {
      const avatar = new File(['jpeg'], 'rex.jpg', { type: 'image/jpeg' })

      void client.forms.changes.post({ body: { name: 'Rex' } })
      void client.forms.scan.post({ body: [] })
      // @ts-expect-error -- the server reads no multipart form into a union body
      void client.forms.changes.post({ body: new FormData() })
      // @ts-expect-error -- not even one whose every member holds the same file
      void client.forms.swaps.post({ body: client.$formData({ kind: 'a', avatar }) })
      // @ts-expect-error -- nor a body that is a file or a list of files
      void client.forms.scan.post({ body: new FormData() })
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

describe('the client options', () => {
  it('take interceptors written on the platform types alone', () => {
    typeOnly(() => {
      const stamp: Interceptor = async (request, next) => {
        expectTypeOf(request).toEqualTypeOf<Request>()
        expectTypeOf(next).returns.toEqualTypeOf<Promise<Response>>()
        request.headers.set('x-request-id', '1')
        return next(request)
      }

      // Still typed from the application it is handed, with interceptors beside it.
      const client = brewer(app, { interceptors: [stamp] })

      expectTypeOf(client.pets.post).toBeCallableWith({ body: { id: 1, name: 'Rex' } })
    })
  })

  it('refuse an interceptor that resolves with nothing, the forgotten return', () => {
    typeOnly(() => {
      brewer(app, {
        interceptors: [
          // @ts-expect-error -- an interceptor resolves with the response it hands back
          async (request, next) => {
            await next(request)
          },
        ],
      })
    })
  })

  it('take an authenticator answering with a request or nothing, and a follow-up limit', () => {
    typeOnly(() => {
      const refresh: Authenticator = async (request, response, attempt) => {
        expectTypeOf(request).toEqualTypeOf<Request>()
        expectTypeOf(response).toEqualTypeOf<Response>()
        expectTypeOf(attempt).toEqualTypeOf<number>()
        return attempt > 1 ? null : request
      }

      const client = brewer(app, { authenticator: refresh, maxFollowUps: 2 })

      expectTypeOf(client.pets.post).toBeCallableWith({ body: { id: 1, name: 'Rex' } })
    })
  })

  it('refuse an authenticator answering with anything but a request', () => {
    typeOnly(() => {
      brewer(app, {
        // @ts-expect-error -- a follow-up is a request, not the URL to send one to
        authenticator: () => 'https://elsewhere.example/login',
      })
    })
  })
})

describe('a body a function opens', () => {
  it('is taken for a body the route does not declare, through $request too', () => {
    typeOnly(() => {
      const uploads = new Router('/uploads').post('/raw').handler(() => ({ stored: true }))
      const files = brewer<typeof uploads>('http://localhost')

      void files.uploads.raw.post({ body: () => new Blob(['upload']).stream() })
      void files.uploads.raw.post({ body: async () => new Blob(['upload']).stream() })
      void files.$request('POST', '/uploads/raw', { body: () => new Blob(['upload']).stream() })
    })
  })

  it('is refused for a body the route declares, which goes as JSON or a form', () => {
    typeOnly(() => {
      // @ts-expect-error -- a declared body is never streamed
      void client.pets.post({ body: () => new Blob(['upload']).stream() })
    })
  })
})
