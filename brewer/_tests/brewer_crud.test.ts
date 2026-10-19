import { $t } from '@caffeinejs/application/schema'
import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

/**
 * One resource driven through its whole life, a verb at each step, over a socket and in process alike: what a
 * test runs in process has to be what production sends over the wire.
 */

const itemSchema = $t.Object({ id: $t.Integer(), name: $t.String(), tags: $t.Array($t.String()) })
const problemSchema = $t.Object({ detail: $t.String() })
const itemParams = $t.Object({ id: $t.Integer() })

type Item = { id: number; name: string; tags: string[] }

const store = new Map<number, Item>()
let lastID = 0

const items = new Router('/items')
  .options('/')
  .status(204)
  .handler(ctx => {
    ctx.header('allow', 'OPTIONS, HEAD, POST, QUERY')
  })
  .post('/')
  .schema({ body: $t.Object({ name: $t.String(), tags: $t.Array($t.String()) }), response: { 201: itemSchema } })
  .status(201)
  .handler(ctx => {
    const item = { id: ++lastID, ...ctx.req.body() }
    store.set(item.id, item)
    return item
  })
  // HEAD on a path no GET answers: a GET's own HEAD twin would collide with it.
  .head('/')
  .handler(ctx => {
    ctx.header('x-total-count', String(store.size))
  })
  .query('/')
  .schema({ body: $t.Object({ tag: $t.String() }), response: { 200: $t.Array(itemSchema) } })
  .handler(ctx => [...store.values()].filter(item => item.tags.includes(ctx.req.body().tag)))
  .get('/:id')
  .schema({ params: itemParams, response: { 200: itemSchema, 404: problemSchema } })
  .handler(ctx => store.get(ctx.req.param().id) ?? ctx.notFound({ detail: `no item ${ctx.req.param().id}` }))
  .put('/:id')
  .schema({ params: itemParams, body: $t.Object({ name: $t.String(), tags: $t.Array($t.String()) }) })
  .handler(ctx => {
    const item = { id: ctx.req.param().id, ...ctx.req.body() }
    store.set(item.id, item)
    return item
  })
  .patch('/:id')
  .schema({ params: itemParams, body: $t.Object({ name: $t.Optional($t.String()) }) })
  .handler(ctx => {
    const item = { ...store.get(ctx.req.param().id)!, ...ctx.req.body() }
    store.set(item.id, item)
    return item
  })
  .delete('/:id')
  .schema({ params: itemParams })
  .status(204)
  .handler(ctx => {
    store.delete(ctx.req.param().id)
  })

const app = createWebApplication().mount(items)

let origin: string

beforeAll(async () => {
  await app.run()
  origin = app.address!.origin
})

afterAll(async () => {
  await app.close()
})

// Both transports reach the one store, so each run starts from an empty one and counts only what it created.
beforeEach(() => {
  store.clear()
})

describe.each([
  ['in process', () => brewer(app)],
  ['over a socket', () => brewer<typeof app>(origin)],
] as const)('brewer driving an item through its life, %s', (_transport, connect) => {
  it('should create, find, replace, update, search and delete it, one verb at each step', async () => {
    const client = connect()

    const options = await client.items.options()
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('OPTIONS, HEAD, POST, QUERY')

    const created = await client.items.post({ body: { name: 'Rex', tags: ['dog'] } })
    expect(created.status).toBe(201)
    const { id } = await created.json()

    const head = await client.items.head()
    expect(head.status).toBe(200)
    expect(head.headers.get('x-total-count')).toBe('1')
    expect(await head.text()).toBe('')

    const found = await client.items({ id }).get()
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({ id, name: 'Rex', tags: ['dog'] })

    const replaced = await client.items({ id }).put({ body: { name: 'Rex II', tags: ['dog', 'senior'] } })
    expect(await replaced.json()).toEqual({ id, name: 'Rex II', tags: ['dog', 'senior'] })

    const updated = await client.items({ id }).patch({ body: { name: 'Rex III' } })
    expect(await updated.json()).toEqual({ id, name: 'Rex III', tags: ['dog', 'senior'] })

    const searched = await client.items.query({ body: { tag: 'senior' } })
    expect(await searched.json()).toEqual([{ id, name: 'Rex III', tags: ['dog', 'senior'] }])

    const deleted = await client.items({ id }).delete()
    expect(deleted.status).toBe(204)
    expect(deleted.body).toBeNull()

    const gone = await client.items({ id }).get()
    expect(gone.status).toBe(404)
    if (gone.status === 404) {
      // Typed from the 404 schema the route declares: checking the status is what narrows the body.
      const problem = await gone.json()
      expect(problem.detail).toBe(`no item ${id}`)
    }
  })
})
