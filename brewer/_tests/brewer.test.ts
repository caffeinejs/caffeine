import { ErrApplicationNotReady } from '@caffeinejs/application'
import { $t } from '@caffeinejs/application/schema'
import { Router, bodyAsBuffer } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ErrBrew,
  ErrBrewPathParam,
  ErrBrewPathValue,
  brewer,
  type BrewClient,
  type BrewOptions,
  type Fetchable,
} from '../index.js'

const petSchema = $t.Object({ id: $t.Integer(), name: $t.String() })
const problemSchema = $t.Object({ detail: $t.String() })

const pets = new Router('/pets')
  .get('/')
  .handler(() => [{ id: 1, name: 'Rex' }])
  .post('/')
  .schema({ body: petSchema })
  .status(201)
  .handler(ctx => ctx.body({ created: ctx.req.body() }))
  .get('/:id')
  .schema({ params: $t.Object({ id: $t.Integer() }), response: { 200: petSchema } })
  .handler(ctx => ({ id: ctx.req.param().id, name: 'Rex' }))
  .get('/:petID/orders/:orderID')
  .handler(ctx => ({ petID: ctx.req.param('petID'), orderID: ctx.req.param('orderID') }))
  .get('/search')
  .handler(ctx => ({ tags: ctx.req.queries('tag') ?? [], tenant: ctx.req.header('x-tenant') ?? null }))
  .post('/upload')
  // Any content type: what is under test is that the client did not re-encode the body or claim it was JSON.
  .extend(bodyAsBuffer())
  .handler(ctx => ({ contentType: ctx.req.header('content-type')?.split(';')[0] }))
  .get('/lost')
  .schema({ response: { 200: petSchema, 404: problemSchema } })
  .handler(ctx => ctx.notFound({ detail: 'no pet answers to that name' }))
  .get('/boom')
  .handler(() => {
    throw new Error('the kennel database is down')
  })
  .get('/get')
  .handler(() => ({ literalVerbSegment: true }))
  .get('/then')
  .handler(() => ({ literalThenSegment: true }))
  .query('/find')
  .schema({ body: $t.Object({ name: $t.String() }) })
  .handler(ctx => ({ found: [ctx.req.body().name] }))
  .get('/query')
  .handler(() => ({ literalQuerySegment: true }))
  .get('/$request')
  .handler(() => ({ literalRequestSegment: true }))
  .get('/tenant')
  .schema({ headers: $t.Object({ 'x-tenant': $t.String(), 'if-match': $t.Optional($t.String()) }) })
  .handler(ctx => ({
    tenant: ctx.req.header('x-tenant'),
    ifMatch: ctx.req.header('if-match') ?? null,
    authorization: ctx.req.header('authorization') ?? null,
  }))

const files = new Router('/files').get('/*').handler(ctx => ({ rest: ctx.req.param()['*'] }))

const tags = new Router('/tags').get('/:name?').handler(ctx => ({ name: ctx.req.param().name ?? null }))

const catalog = new Router('/catalog')
  .get('/search')
  .schema({
    querystring: $t.Object({
      q: $t.Optional($t.String()),
      limit: $t.Optional($t.Integer()),
      archived: $t.Optional($t.Boolean()),
      tags: $t.Optional($t.Array($t.String())),
    }),
  })
  .handler(ctx => ctx.req.query())
  .get('/raw')
  .handler(ctx => ({ url: ctx.req.url }))

// Declared in lower case, which `.route(...)` takes and the route's type keeps.
const legacy = new Router('/legacy').route('patch', '/lower').handler(ctx => ({ method: ctx.req.method }))

// A root segment named like the escape hatch, which keeps that name for itself.
const hatch = new Router('/$request').get('/').handler(() => ({ literalRequestRoot: true }))

// Segments holding more than one parameter, or text beside one: each answers the parameters the router bound.
const shapes = new Router('/shapes')
  .get('/near/:lat-:lng')
  .handler(ctx => ctx.req.param())
  .get('/files/:name.:ext')
  .handler(ctx => ctx.req.param())
  .get('/span/:from-:to-:step')
  .handler(ctx => ctx.req.param())
  .get('/ver/:major.:minor.:patch')
  .handler(ctx => ctx.req.param())
  .get('/mixed/:a-:b.:c')
  .handler(ctx => ctx.req.param())
  .get('/at/:hour(^\\d{2})h:minute(^\\d{2})m')
  .handler(ctx => ctx.req.param())
  .get('/pair/:a(^\\d+)-:b')
  .handler(ctx => ctx.req.param())
  .get('/doc/:name.json')
  .handler(ctx => ctx.req.param())
  .get('/api/v:version')
  .handler(ctx => ctx.req.param())
  .get('/item/item-:id.json')
  .handler(ctx => ctx.req.param())
  .get('/radius/:lat-:lng/r/:r')
  .handler(ctx => ctx.req.param())
  .get('/opt/:lat-:lng?')
  .handler(ctx => ctx.req.param())
  .get('/rgx/:id(^(?:\\d+)$)')
  .handler(ctx => ctx.req.param())
  .get('/esc/a::b/:id')
  .handler(ctx => ctx.req.param())
  .get('/tail/:id-:rev/*')
  .handler(ctx => ctx.req.param())
  .get('/k/:lat:lng')
  .handler(ctx => ctx.req.param())
  .get('/tags/:id(^\\d+)?')
  .handler(ctx => ctx.req.param())
  .get('/item2/item-:id?')
  .handler(ctx => ctx.req.param())
  .get('/pct/:a-%:b')
  .handler(ctx => ctx.req.param())
  .get('/hash/:a-#:b')
  .handler(ctx => ctx.req.param())
  .get('/pre/100%-:id')
  .handler(ctx => ctx.req.param())

const app = createWebApplication().mount(pets, files, tags, catalog, legacy, hatch, shapes)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

/** A client over the application's own `fetch`, recording every URL it is handed. */
function spied(): { client: BrewClient<typeof app>; sent: string[] } {
  const sent: string[] = []
  const client = brewer(app, {
    fetch: (input, init) => {
      sent.push(String(input))
      return app.fetch(input as string, init)
    },
  })

  return { client, sent }
}

describe('brewer against a running server', () => {
  describe('given a path with parameters', () => {
    it('should place each value in its own segment', async () => {
      const client = brewer<typeof app>(origin)

      expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
      expect(await (await client.pets({ petID: 'p1' }).orders({ orderID: 'o2' }).get()).json()).toEqual({
        petID: 'p1',
        orderID: 'o2',
      })
    })

    it('should URI-encode a value that needs it, so it arrives as it was given', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets({ petID: 'a b/c' }).orders({ orderID: 'ø' }).get()
      const reserved = await client.pets({ petID: '50% off?#/x' }).orders({ orderID: 'o&p=q+r' }).get()

      expect(await res.json()).toEqual({ petID: 'a b/c', orderID: 'ø' })
      expect(await reserved.json()).toEqual({ petID: '50% off?#/x', orderID: 'o&p=q+r' })
    })

    it('should send 0, which is a value', async () => {
      const client = brewer<typeof app>(origin)

      expect(await (await client.pets({ id: 0 }).get()).json()).toEqual({ id: 0, name: 'Rex' })
    })

    it('should keep the slashes of a wildcard, so it can carry a nested path', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.files({ '*': 'a/b/c.txt' }).get()

      expect(await res.json()).toEqual({ rest: 'a/b/c.txt' })
    })

    // A file name is anything a person typed: a `?` or `#` left as it is would end the path, a `%` would be read as
    // an escape.
    it('should encode everything between the slashes of a wildcard', async () => {
      const client = brewer<typeof app>(origin)
      const rest = 'docs/2026 Q1 report?final#2 100%.pdf'

      expect(await (await client.files({ '*': rest }).get()).json()).toEqual({ rest })
      expect(await (await client.$request('GET', '/files/*', { params: { '*': rest } })).json()).toEqual({ rest })
    })
  })

  // The server is the oracle: what each route answers is what find-my-way bound from the path the client built.
  describe('given a segment holding more than one parameter, or text beside one', () => {
    it('should fill parameters separated by - or ., so each arrives under its own name', async () => {
      const client = brewer<typeof app>(origin)

      const near = await client.$request('GET', '/shapes/near/:lat-:lng', { params: { lat: '1.5', lng: '2.5' } })
      const file = await client.$request('GET', '/shapes/files/:name.:ext', { params: { name: 'report', ext: 'pdf' } })
      const span = await client.$request('GET', '/shapes/span/:from-:to-:step', {
        params: { from: '1', to: '9', step: '2' },
      })
      const ver = await client.$request('GET', '/shapes/ver/:major.:minor.:patch', {
        params: { major: '1', minor: '2', patch: '3' },
      })
      const mixed = await client.$request('GET', '/shapes/mixed/:a-:b.:c', { params: { a: 'x', b: 'y', c: 'z' } })

      expect(await near.json()).toEqual({ lat: '1.5', lng: '2.5' })
      expect(await file.json()).toEqual({ name: 'report', ext: 'pdf' })
      expect(await span.json()).toEqual({ from: '1', to: '9', step: '2' })
      expect(await ver.json()).toEqual({ major: '1', minor: '2', patch: '3' })
      expect(await mixed.json()).toEqual({ a: 'x', b: 'y', c: 'z' })
    })

    it('should keep the text a constraint is followed by, and leave a colon inside one alone', async () => {
      const client = brewer<typeof app>(origin)

      const at = await client.$request('GET', '/shapes/at/:hour(^\\d{2})h:minute(^\\d{2})m', {
        params: { hour: '08', minute: '24' },
      })
      const pair = await client.$request('GET', '/shapes/pair/:a(^\\d+)-:b', { params: { a: '12', b: 'x' } })
      const rgx = await client.$request('GET', '/shapes/rgx/:id(^(?:\\d+)$)', { params: { id: '42' } })

      expect(await at.json()).toEqual({ hour: '08', minute: '24' })
      expect(await pair.json()).toEqual({ a: '12', b: 'x' })
      expect(await rgx.json()).toEqual({ id: '42' })
    })

    it('should keep the text before and after a parameter, and write a doubled colon as one', async () => {
      const { client, sent } = spied()

      const doc = await client.$request('GET', '/shapes/doc/:name.json', { params: { name: 'report' } })
      const api = await client.$request('GET', '/shapes/api/v:version', { params: { version: '2' } })
      const item = await client.$request('GET', '/shapes/item/item-:id.json', { params: { id: '7' } })
      const esc = await client.$request('GET', '/shapes/esc/a::b/:id', { params: { id: '7' } })
      const named = await client.$request('GET', '/shapes/k/:lat:lng', { params: { 'lat:lng': 'x' } })

      expect(await doc.json()).toEqual({ name: 'report' })
      expect(await api.json()).toEqual({ version: '2' })
      expect(await item.json()).toEqual({ id: '7' })
      expect(await esc.json()).toEqual({ id: '7' })
      expect(await named.json()).toEqual({ 'lat:lng': 'x' })
      expect(sent).toEqual([
        'http://localhost/shapes/doc/report.json',
        'http://localhost/shapes/api/v2',
        'http://localhost/shapes/item/item-7.json',
        'http://localhost/shapes/esc/a:b/7',
        'http://localhost/shapes/k/x',
      ])
    })

    it('should keep reading the segments after a shared one, a wildcard included', async () => {
      const client = brewer<typeof app>(origin)

      const radius = await client.$request('GET', '/shapes/radius/:lat-:lng/r/:r', {
        params: { lat: '1', lng: '2', r: '3' },
      })
      const tail = await client.$request('GET', '/shapes/tail/:id-:rev/*', {
        params: { id: '7', rev: '3', '*': 'a b/c.txt' },
      })

      expect(await radius.json()).toEqual({ lat: '1', lng: '2', r: '3' })
      expect(await tail.json()).toEqual({ id: '7', rev: '3', '*': 'a b/c.txt' })
    })

    it('should encode each value on its own, so reserved characters arrive as given', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.$request('GET', '/shapes/files/:name.:ext', { params: { name: '50% off?#', ext: 'ø' } })

      expect(await res.json()).toEqual({ name: '50% off?#', ext: 'ø' })
    })

    it('should drop an optional shared segment given no value, and reach the route without it', async () => {
      const { client, sent } = spied()

      const both = await client.$request('GET', '/shapes/opt/:lat-:lng?', { params: { lat: '1', lng: '2' } })
      const none = await client.$request('GET', '/shapes/opt/:lat-:lng?')

      expect(await both.json()).toEqual({ lat: '1', lng: '2' })
      expect(await none.json()).toEqual({})
      // Only a call the types do not check can send one of the two: through a cast, or plain JavaScript.
      const some = client.$request('GET', '/shapes/opt/:lat-:lng?', { params: { lat: '1' } as never })
      await expect(some).rejects.toMatchObject({
        name: 'ErrBrewPathParam',
        message: expect.stringContaining('no value for path parameter "lng"'),
      })
      expect(sent).toEqual(['http://localhost/shapes/opt/1-2', 'http://localhost/shapes/opt'])
    })

    it('should refuse, before sending anything, a shared segment its values fill as a step', async () => {
      const { client, sent } = spied()

      await expect(
        client.$request('GET', '/shapes/files/:name.:ext', { params: { name: '', ext: '' } }),
      ).rejects.toMatchObject({
        name: 'ErrBrewPathValue',
        message: expect.stringContaining('segment ":name.:ext" is "." once filled'),
      })
      expect(sent).toEqual([])
    })

    it('should send a ? the router does not read as optional, and the parameter it names', async () => {
      const { client, sent } = spied()

      const tags = await client.$request('GET', '/shapes/tags/:id(^\\d+)?', { params: { id: '42' } })
      const item = await client.$request('GET', '/shapes/item2/item-:id?', { params: { 'id?': '7' } })

      expect(await tags.json()).toEqual({ id: '42' })
      expect(await item.json()).toEqual({ 'id?': '7' })
      expect(sent).toEqual(['http://localhost/shapes/tags/42%3F', 'http://localhost/shapes/item2/item-7'])
    })

    it('should escape the text beside a parameter so the router matches it', async () => {
      const client = brewer<typeof app>(origin)

      const pct = await client.$request('GET', '/shapes/pct/:a-%:b', { params: { a: '1', b: '2' } })
      const hash = await client.$request('GET', '/shapes/hash/:a-#:b', { params: { a: '1', b: '2' } })
      const pre = await client.$request('GET', '/shapes/pre/100%-:id', { params: { id: '7' } })

      expect(await pct.json()).toEqual({ a: '1', b: '2' })
      expect(await hash.json()).toEqual({ a: '1', b: '2' })
      expect(await pre.json()).toEqual({ id: '7' })
    })

    it('should still reach a lone constrained parameter through the proxy', async () => {
      const client = brewer<typeof app>(origin)

      expect(await (await client.shapes.rgx({ id: '42' }).get()).json()).toEqual({ id: '42' })
    })
  })

  describe('given a query', () => {
    it('should repeat a key per array item', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets.search.get({ query: { tag: ['a', 'b'], skipped: undefined } })

      expect(await res.json()).toMatchObject({ tags: ['a', 'b'] })
    })

    it('should send reserved characters and unicode so they arrive as they were given', async () => {
      const client = brewer<typeof app>(origin)
      const q = 'a&b=c d+e/f?g#h%i ü 😀'

      expect(await (await client.catalog.search.get({ query: { q } })).json()).toEqual({ q })
    })

    it('should send 0 and false, which are values rather than absences', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.catalog.search.get({ query: { limit: 0, archived: false } })

      expect(await res.json()).toEqual({ limit: 0, archived: false })
    })

    it('should send a lone item so the server still reads a list where the schema declares one', async () => {
      const client = brewer<typeof app>(origin)

      expect(await (await client.catalog.search.get({ query: { tags: ['solo'] } })).json()).toEqual({
        tags: ['solo'],
      })
    })

    it('should leave out undefined, null and empty lists, adding no bare question mark', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.catalog.raw.get({ query: { cursor: undefined, after: null, tag: [] } })

      expect(await res.json()).toEqual({ url: '/catalog/raw' })
    })

    it('should let the query be left out when nothing in it is required', async () => {
      const client = brewer<typeof app>(origin)

      expect(await (await client.catalog.search.get()).json()).toEqual({})
    })
  })

  describe('given a body', () => {
    it('should send an object as JSON', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets.post({ body: { id: 1, name: 'Rex' } })

      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ created: { id: 1, name: 'Rex' } })
    })

    it('should pass a FormData body through without encoding it', async () => {
      const client = brewer<typeof app>(origin)
      const form = new FormData()
      form.set('file', 'contents')

      const res = await client.pets.upload.post({ body: form })

      expect(await res.json()).toEqual({ contentType: 'multipart/form-data' })
    })
  })

  describe('given headers', () => {
    it('should merge the call over the client, resolving a function per request', async () => {
      let calls = 0
      const client = brewer<typeof app>(origin, {
        headers: async () => {
          calls++
          return { 'x-tenant': 'from-client' }
        },
      })

      expect(await (await client.pets.search.get()).json()).toMatchObject({ tenant: 'from-client' })
      expect(await (await client.pets.search.get({ headers: { 'x-tenant': 'from-call' } })).json()).toMatchObject({
        tenant: 'from-call',
      })
      expect(calls).toBe(2)
    })
  })

  describe('given a route that answers with an error status', () => {
    it('should resolve with it, the body still readable, rather than throw', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets.lost.get()

      expect(res.ok).toBe(false)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ detail: 'no pet answers to that name' })
    })
  })

  describe('given a segment named after a verb', () => {
    it('should be reachable through the escape hatch', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.$request('GET', '/pets/get')

      expect(await res.json()).toEqual({ literalVerbSegment: true })
    })
  })

  describe('given a route declared with QUERY', () => {
    it('should send QUERY, the body carrying the search', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets.find.query({ body: { name: 'Rex' } })

      expect(await res.json()).toEqual({ found: ['Rex'] })
    })

    it('should reach a segment named query through the escape hatch', async () => {
      const client = brewer<typeof app>(origin)

      expect(await (await client.$request('GET', '/pets/query')).json()).toEqual({ literalQuerySegment: true })
    })
  })

  // fetch upper-cases only the six methods the standard names, and a server refuses `patch` in lower case.
  describe('given a method declared in lower case', () => {
    it('should send it upper-cased through the escape hatch', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.$request('patch', '/legacy/lower')

      expect(await res.json()).toEqual({ method: 'PATCH' })
    })
  })

  describe('given a client typed from a single router', () => {
    it("should call that router's routes", async () => {
      const client = brewer<typeof pets>(origin)

      expect(await (await client.pets.get()).json()).toEqual([{ id: 1, name: 'Rex' }])
    })
  })
})

// No socket here: the application is handed over as the target, so requests go through its own `fetch`.
describe('brewer against an application in process', () => {
  describe('given the application itself rather than a URL', () => {
    it('should reach its routes with neither a type argument nor an origin', async () => {
      const client = brewer(app)

      expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
      expect(await (await client.pets.get()).json()).toEqual([{ id: 1, name: 'Rex' }])
    })

    it('should carry a JSON body, a query and per-call headers through', async () => {
      const client = brewer(app)

      const created = await client.pets.post({ body: { id: 2, name: 'Milou' } })
      expect(created.status).toBe(201)
      expect(await created.json()).toEqual({ created: { id: 2, name: 'Milou' } })

      const searched = await client.pets.search.get({
        query: { tag: ['x', 'y'] },
        headers: { 'x-tenant': 't1' },
      })

      expect(await searched.json()).toEqual({ tags: ['x', 'y'], tenant: 't1' })
    })

    it('should report a rejected body rather than throw', async () => {
      const client = brewer(app)

      const res = await client.pets.post({ body: { id: 'not-an-integer' } as never })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
    })

    it('should report a failure the handler did not expect rather than throw', async () => {
      const client = brewer(app)

      const res = await client.pets.boom.get()

      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ statusCode: 500, code: 'ERR_INTERNAL' })
    })
  })

  describe('given client headers in any shape the platform takes', () => {
    // Pairs to iterate, as every Headers is, but not this realm's: what a polyfill or another copy of undici hands
    // over, which `instanceof Headers` does not recognise. Cast, since it implements only the iteration that is read.
    class ForeignHeaders {
      *[Symbol.iterator](): Generator<[string, string]> {
        yield ['x-tenant', 't1']
      }
    }

    const shapes: Array<[string, BrewOptions['headers']]> = [
      ['a record', { 'x-tenant': 't1' }],
      ['a Headers', new Headers({ 'x-tenant': 't1' })],
      ['a Headers from another realm or library', new ForeignHeaders() as unknown as Headers],
      ['a list of pairs', [['x-tenant', 't1']]],
      ['a function', () => ({ 'x-tenant': 't1' })],
      ['an async function', async () => new Headers({ 'x-tenant': 't1' })],
    ]

    it.each(shapes)('should send them from %s', async (_shape, headers) => {
      const client = brewer(app, { headers })

      expect(await (await client.pets.search.get()).json()).toEqual({ tags: [], tenant: 't1' })
    })

    it('should let a call header win over the client one, whatever the case of either', async () => {
      const client = brewer(app, { headers: { 'X-Tenant': 'from-client' } })

      const res = await client.pets.search.get({ headers: { 'x-tenant': 'from-call' } })

      expect(await res.json()).toEqual({ tags: [], tenant: 'from-call' })
    })
  })

  describe('given a header with no value', () => {
    it('should leave it out rather than send the word undefined', async () => {
      let token: string | undefined
      const client = brewer(app, { headers: () => ({ authorization: token }) })

      const anonymous = await client.pets.tenant.get({ headers: { 'x-tenant': 't1', 'if-match': undefined } })
      expect(await anonymous.json()).toEqual({ tenant: 't1', ifMatch: null, authorization: null })

      token = 'Bearer abc'
      const signedIn = await client.pets.tenant.get({ headers: { 'x-tenant': 't1' } })
      expect(await signedIn.json()).toEqual({ tenant: 't1', ifMatch: null, authorization: 'Bearer abc' })
    })
  })

  // A server keeps the headers no schema names, so declaring one never stops a call sending another.
  describe('given a route that declares some of its headers', () => {
    it('should send the others beside them', async () => {
      const client = brewer(app)

      const res = await client.pets.tenant.get({ headers: { 'x-tenant': 't1', authorization: 'Bearer per-call' } })

      expect(await res.json()).toEqual({ tenant: 't1', ifMatch: null, authorization: 'Bearer per-call' })
    })
  })

  // Anything awaited is asked for `then`, and a node that answered it would be taken for a promise that never settles.
  describe('given code that probes the client for a protocol', () => {
    it('should settle when the client is returned from an async function, and still send', async () => {
      const ready = async () => brewer(app)

      const client = await ready()

      expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
    })

    it('should answer then with nothing at any depth, so a node awaited is the node itself', async () => {
      const client = brewer(app)

      expect(Reflect.get(client, 'then')).toBeUndefined()
      expect(Reflect.get(client.pets({ id: 7 }), 'then')).toBeUndefined()

      const pets = await Promise.resolve(client.pets)
      expect(await (await pets.get()).json()).toEqual([{ id: 1, name: 'Rex' }])
    })

    it('should reach a segment named then through the escape hatch', async () => {
      const client = brewer(app)

      expect(await (await client.$request('GET', '/pets/then')).json()).toEqual({ literalThenSegment: true })
    })

    it('should not answer a symbol, so the client is not taken for an iterable', () => {
      const client = brewer(app)

      expect(() => [...(client as unknown as Iterable<unknown>)]).toThrow(TypeError)
    })
  })

  describe('given a node kept aside', () => {
    it('should build every call from where it was kept, without one call reaching into another', async () => {
      const client = brewer(app)
      const pets = client.pets
      const pet = pets({ petID: 'p1' })

      expect(await (await pets({ id: 1 }).get()).json()).toEqual({ id: 1, name: 'Rex' })
      expect(await (await pets({ id: 2 }).get()).json()).toEqual({ id: 2, name: 'Rex' })
      expect(await (await pet.orders({ orderID: 'a' }).get()).json()).toEqual({ petID: 'p1', orderID: 'a' })
      expect(await (await pet.orders({ orderID: 'b' }).get()).json()).toEqual({ petID: 'p1', orderID: 'b' })
      expect(await (await pets.get()).json()).toEqual([{ id: 1, name: 'Rex' }])
    })
  })

  describe('given an optional path parameter', () => {
    it('should add no segment when it is left out, as the escape hatch does', async () => {
      const client = brewer(app)

      expect(await (await client.tags({}).get()).json()).toEqual({ name: null })
      expect(await (await client.tags({ name: undefined }).get()).json()).toEqual({ name: null })
      expect(await (await client.$request('GET', '/tags/:name?')).json()).toEqual({ name: null })
    })

    it('should place it when it is given', async () => {
      const client = brewer(app)

      expect(await (await client.tags({ name: 'cute' }).get()).json()).toEqual({ name: 'cute' })
    })
  })

  // The proxy cannot tell `:id` from `:name?`, so it leaves out any parameter given no value: only the types require
  // one. The escape hatch knows the path, and refuses.
  describe('given a required path parameter forced to no value, past the types', () => {
    it('should reach the parent route through the proxy, where the escape hatch rejects and sends nothing', async () => {
      const { client, sent } = spied()

      const res = await client.pets({ id: undefined as never }).get()
      const refused = client.$request('GET', '/pets/:id', { params: { id: undefined as never } })

      await expect(refused).rejects.toBeInstanceOf(ErrBrewPathParam)
      expect(await res.json()).toEqual([{ id: 1, name: 'Rex' }])
      expect(sent).toEqual(['http://localhost/pets'])
    })
  })

  // The URL standard resolves `.` and `..` as steps along the path, percent-encoded or not: `/pets/../orders/o1` is
  // `/orders/o1`. A value from a link or a form must never choose which route a call reaches.
  describe('given a path value that a URL would resolve as a step along the path', () => {
    it('should reject a parameter of . or .., naming it and the route, and send nothing', async () => {
      const { client, sent } = spied()

      await expect(client.pets({ petID: '..' }).orders({ orderID: 'o1' }).get()).rejects.toMatchObject({
        name: 'ErrBrewPathValue',
        code: 'ERR_BREW_PATH_VALUE',
        message: expect.stringContaining(
          'Cannot build a request for "/pets/:petID/orders/:orderID": path parameter "petID" is ".."',
        ),
      })
      await expect(client.pets({ petID: 'p1' }).orders({ orderID: '.' }).get()).rejects.toBeInstanceOf(ErrBrewPathValue)
      expect(sent).toEqual([])
    })

    it('should reject a wildcard with a . or .. part, through the proxy and the escape hatch', async () => {
      const { client, sent } = spied()

      await expect(client.files({ '*': '../admin/users' }).get()).rejects.toBeInstanceOf(ErrBrewPathValue)
      await expect(client.files({ '*': 'a/./b' }).get()).rejects.toBeInstanceOf(ErrBrewPathValue)
      await expect(client.$request('GET', '/files/*', { params: { '*': 'docs/..' } })).rejects.toMatchObject({
        message: expect.stringContaining('Cannot build a request for "/files/*": path parameter "*" is "docs/.."'),
      })
      expect(sent).toEqual([])
    })

    it('should send a value that merely holds dots', async () => {
      const client = brewer(app)

      for (const value of ['...', '..x', 'a..b', '.hidden']) {
        const res = await client.pets({ petID: value }).orders({ orderID: value }).get()
        expect(await res.json()).toEqual({ petID: value, orderID: value })
      }
      expect(await (await client.files({ '*': '.config/x..y/...' }).get()).json()).toEqual({ rest: '.config/x..y/...' })
    })
  })

  describe('given the escape hatch', () => {
    it('should carry params, a query, headers and a body to a route named by its path', async () => {
      const client = brewer(app)

      const created = await client.$request('POST', '/pets', { body: { id: 3, name: 'Milou' } })
      const searched = await client.$request('GET', '/pets/search', {
        query: { tag: ['x'] },
        headers: { 'x-tenant': 't9' },
      })
      const order = await client.$request('GET', '/pets/:petID/orders/:orderID', {
        params: { petID: 'a b', orderID: 'ø' },
      })

      expect(created.status).toBe(201)
      expect(await created.json()).toEqual({ created: { id: 3, name: 'Milou' } })
      expect(await searched.json()).toEqual({ tags: ['x'], tenant: 't9' })
      expect(await order.json()).toEqual({ petID: 'a b', orderID: 'ø' })
    })

    it('should reach a root segment named $request, whose name it keeps, while the proxy reaches one deeper down', async () => {
      const client = brewer(app)

      expect(await (await client.$request('GET', '/$request')).json()).toEqual({ literalRequestRoot: true })
      expect(await (await client.pets.$request.get()).json()).toEqual({ literalRequestSegment: true })
    })

    it('should reject a path parameter with no value, naming it and the path, and send nothing', async () => {
      const { client, sent } = spied()

      const pending = client.$request('GET', '/pets/:id', { params: {} as never })

      await expect(pending).rejects.toBeInstanceOf(ErrBrewPathParam)
      await expect(pending).rejects.toBeInstanceOf(ErrBrew)
      await expect(pending).rejects.toMatchObject({
        code: 'ERR_BREW_PATH_PARAM',
        message: expect.stringContaining('Cannot build a request for "/pets/:id": no value for path parameter "id"'),
      })
      expect(sent).toEqual([])
    })
  })

  describe('given a fetch supplied alongside the application', () => {
    it('should call the supplied one, so a transport can still be swapped out', async () => {
      const { client, sent } = spied()

      expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
      expect(sent).toEqual(['http://localhost/pets/7'])
    })
  })

  // A gateway serves the application under `/api`. The base belongs in the client's base URL, as it belongs in an
  // OpenAPI document's `servers`; the routes stay the ones the application declares.
  describe('given a base URL naming the base path the application is served under', () => {
    it.each(['http://localhost/api', 'http://localhost/api/'])(
      'should keep it in every request, from %s',
      async baseURL => {
        const based = createWebApplication().basePath('/api').mount(pets)
        await based.bootstrap()

        try {
          const calls: string[] = []
          const client = brewer<typeof based>(baseURL, {
            fetch: (input, init) => {
              calls.push(String(input))
              return based.fetch(input as string, init)
            },
          })

          expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
          expect(calls).toEqual(['http://localhost/api/pets/7'])
        } finally {
          await based.close()
        }
      },
    )
  })

  // A page calling the origin it was served from names no host: the browser resolves the path against the page.
  describe('given a base URL that is only a path', () => {
    it.each([
      ['/api', '/api/pets/search?tag=a'],
      ['', '/pets/search?tag=a'],
    ])('should hand the transport the path under %j', async (baseURL, expected) => {
      const calls: string[] = []
      const client = brewer<typeof app>(baseURL, {
        fetch: async input => {
          calls.push(String(input))
          return Response.json({ tags: ['a'], tenant: null })
        },
      })

      await client.pets.search.get({ query: { tag: ['a'] } })

      expect(calls).toEqual([expected])
    })
  })

  describe('given an application that was never set up', () => {
    it('should reject every call, since there is no server to answer it', async () => {
      const idle = createWebApplication().mount(pets)

      await expect(brewer(idle).pets.get()).rejects.toBeInstanceOf(ErrApplicationNotReady)
    })
  })

  describe('given anything else that answers like fetch', () => {
    it('should use it, since the target is structural', async () => {
      const stub: Fetchable = { fetch: async () => Response.json({ id: 9, name: 'Stub' }) }
      const client = brewer<typeof app>(stub)

      expect(await (await client.pets({ id: 9 }).get()).json()).toEqual({ id: 9, name: 'Stub' })
    })
  })
})
