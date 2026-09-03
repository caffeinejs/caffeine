import { Router, bodyAsBuffer, createWebApplication } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer, type Fetchable } from '../brewer.js'
import { ErrBrewPathParam } from '../errors.js'

const petSchema = $t.Object({ id: $t.Integer(), name: $t.String() })

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
  .handler(ctx => ({ tags: ctx.req.queries('tag') ?? [], tenant: ctx.req.header('x-tenant') }))
  .post('/upload')
  // Any content type: what is under test is that the client did not re-encode the body or claim it was JSON.
  .with(bodyAsBuffer())
  .handler(ctx => ({ contentType: ctx.req.header('content-type')?.split(';')[0] }))
  .get('/slow')
  .handler(ctx => new Promise(resolve => setTimeout(() => resolve(ctx.body({ done: true })), 200)))
  .get('/get')
  .handler(() => ({ literalVerbSegment: true }))

const files = new Router('/files').get('/*').handler(ctx => ({ rest: ctx.req.param()['*'] }))

const app = createWebApplication().build().mount(pets, files)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

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

    it('should URI-encode a value that needs it', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets({ petID: 'a b/c' }).orders({ orderID: 'ø' }).get()

      expect(await res.json()).toEqual({ petID: 'a b/c', orderID: 'ø' })
    })

    it('should leave a wildcard un-encoded, so it can carry slashes', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.files({ '*': 'a/b/c.txt' }).get()

      expect(await res.json()).toEqual({ rest: 'a/b/c.txt' })
    })
  })

  describe('given a query', () => {
    it('should repeat a key per array item', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.pets.search.get({ query: { tag: ['a', 'b'], skipped: undefined } })

      expect(await res.json()).toMatchObject({ tags: ['a', 'b'] })
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

      const res = await client.pets.upload.post({ body: form as never })

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
    it('should report it rather than throw', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.$request('GET', '/pets/:id', { params: { id: 1 } })
      expect(res.ok).toBe(true)

      const missing = await fetch(`${origin}/nothing-here`)
      expect(missing.ok).toBe(false)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ statusCode: 404 })
    })
  })

  describe('given an aborted request', () => {
    it('should reject rather than resolve', async () => {
      const client = brewer<typeof app>(origin)
      const controller = new AbortController()

      const pending = client.pets.slow.get({ signal: controller.signal })
      controller.abort()

      await expect(pending).rejects.toThrow()
    })
  })

  describe('given a segment named after a verb', () => {
    it('should be reachable through the escape hatch', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.$request('GET', '/pets/get')

      expect(await res.json()).toEqual({ literalVerbSegment: true })
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

    it('should reach a segment named after a verb through the escape hatch', async () => {
      const client = brewer(app)

      expect(await (await client.$request('GET', '/pets/get')).json()).toEqual({ literalVerbSegment: true })
    })
  })

  describe('given a fetch supplied alongside the application', () => {
    it('should call the supplied one, so a transport can still be swapped out', async () => {
      const calls: string[] = []
      const client = brewer(app, {
        fetch: (input, init) => {
          calls.push(String(input))
          return app.fetch(input as string, init)
        },
      })

      expect(await (await client.pets({ id: 7 }).get()).json()).toEqual({ id: 7, name: 'Rex' })
      expect(calls).toEqual(['http://localhost/pets/7'])
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

describe('fillPath', () => {
  describe('given a path parameter with no value', () => {
    it('should say which one, and where', async () => {
      const client = brewer<typeof app>(origin)

      expect(() => client.$request('GET', '/pets/:id', { params: {} as never })).toThrow(ErrBrewPathParam)
    })
  })
})
