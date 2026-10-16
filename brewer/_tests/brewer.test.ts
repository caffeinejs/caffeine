import { Router, bodyAsBuffer } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { $t } from '@caffeinejs/std/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { brewer, type Fetchable } from '../brewer.js'
import { ErrBrew, ErrBrewPathParam, ErrBrewPathValue } from '../errors.js'
import { fillPath, joinURL } from '../url.js'

const petSchema = $t.Object({ id: $t.Integer(), name: $t.String() })
const problemSchema = $t.Object({ detail: $t.String() })

// Holds a request in its handler until the test lets it go, so an abort lands while the server is still working.
let latch: { started: () => void; held: Promise<void> } | undefined

function hold(): { started: Promise<void>; release: () => void } {
  const started = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  latch = { started: started.resolve, held: held.promise }

  return { started: started.promise, release: held.resolve }
}

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
  .extend(bodyAsBuffer())
  .handler(ctx => ({ contentType: ctx.req.header('content-type')?.split(';')[0] }))
  .get('/held')
  .handler(async () => {
    latch?.started()
    await latch?.held
    return { done: true }
  })
  .get('/lost')
  .schema({ response: { 200: petSchema, 404: problemSchema } })
  .handler(ctx => ctx.notFound({ detail: 'no pet answers to that name' }))
  .get('/get')
  .handler(() => ({ literalVerbSegment: true }))
  .get('/then')
  .handler(() => ({ literalThenSegment: true }))

const files = new Router('/files').get('/*').handler(ctx => ({ rest: ctx.req.param()['*'] }))

const tags = new Router('/tags').get('/:name?').handler(ctx => ({ name: ctx.req.param().name ?? null }))

// Declared in lower case, which `.route(...)` takes and the route's type keeps.
const legacy = new Router('/legacy').route('patch', '/lower').handler(ctx => ({ method: ctx.req.method }))

const app = createWebApplication().mount(pets, files, tags, legacy)

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

  describe('given a request aborted while the server is still working on it', () => {
    it('should reject with the abort', async () => {
      const client = brewer<typeof app>(origin)
      const controller = new AbortController()
      const { started, release } = hold()

      try {
        const pending = client.pets.held.get({ signal: controller.signal })
        await started
        controller.abort()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        release()
      }
    })
  })

  describe('given a segment named after a verb', () => {
    it('should be reachable through the escape hatch', async () => {
      const client = brewer<typeof app>(origin)

      const res = await client.$request('GET', '/pets/get')

      expect(await res.json()).toEqual({ literalVerbSegment: true })
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

    it('should reach a segment named after a verb through the escape hatch', async () => {
      const client = brewer(app)

      expect(await (await client.$request('GET', '/pets/get')).json()).toEqual({ literalVerbSegment: true })
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

  describe('given an optional path parameter', () => {
    it('should add no segment when it is left out, as the escape hatch does', async () => {
      const client = brewer(app)

      expect(await (await client.tags({}).get()).json()).toEqual({ name: null })
      expect(await (await client.tags({ name: undefined }).get()).json()).toEqual({ name: null })
      expect(await (await client.$request('GET', '/tags/:name?', { params: {} })).json()).toEqual({ name: null })
    })

    it('should place it when it is given', async () => {
      const client = brewer(app)

      expect(await (await client.tags({ name: 'cute' }).get()).json()).toEqual({ name: 'cute' })
    })
  })

  // The URL standard resolves `.` and `..` as steps along the path, percent-encoded or not: `/pets/../orders/o1` is
  // `/orders/o1`. A value from a link or a form must never choose which route a call reaches.
  describe('given a path value that a URL would resolve as a step along the path', () => {
    function spied() {
      const sent: string[] = []
      const client = brewer(app, {
        fetch: (input, init) => {
          sent.push(String(input))
          return app.fetch(input as string, init)
        },
      })

      return { client, sent }
    }

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

  describe('given anything else that answers like fetch', () => {
    it('should use it, since the target is structural', async () => {
      const stub: Fetchable = { fetch: async () => Response.json({ id: 9, name: 'Stub' }) }
      const client = brewer<typeof app>(stub)

      expect(await (await client.pets({ id: 9 }).get()).json()).toEqual({ id: 9, name: 'Stub' })
    })
  })
})

describe('fillPath', () => {
  it('finds the parameter before a long malformed constraint', () => {
    const started = performance.now()
    expect(fillPath('/:id' + '('.repeat(100_000) + '\nx', { id: 'a/b' })).toBe('/a%2Fb')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('preserves constrained and optional parameters', () => {
    expect(fillPath('/:id(^\\d+$)', { id: 42 })).toBe('/42')
    expect(fillPath('/pets/:id?', {})).toBe('/pets')
    expect(fillPath('/assets/*', { '*': 'a/b' })).toBe('/assets/a/b')
  })

  it('requires a wildcard like any other parameter', () => {
    expect(fillPath('/assets/*', { '*': '' })).toBe('/assets/')
    expect(() => fillPath('/assets/*', {})).toThrow(ErrBrewPathParam)
  })

  describe('given a path parameter with no value', () => {
    it('should reject, naming the parameter and the path, and send nothing', async () => {
      const sent: string[] = []
      const client = brewer(app, {
        fetch: (input, init) => {
          sent.push(String(input))
          return app.fetch(input as string, init)
        },
      })

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
})

// Joined, never resolved: `new URL('/pets', 'https://gw.example/api')` is `https://gw.example/pets`, and a base URL
// naming the application's base path has to keep it.
describe('joinURL', () => {
  it.each([
    ['https://gw.example/api', '/pets/7', 'https://gw.example/api/pets/7'],
    ['https://gw.example/api/', '/pets/7', 'https://gw.example/api/pets/7'],
    ['https://gw.example/api', '/', 'https://gw.example/api'],
    ['https://gw.example', '/pets', 'https://gw.example/pets'],
  ])('should join %s and %s into %s', (baseURL, path, expected) => {
    expect(joinURL(baseURL, path)).toBe(expected)
  })
})
