import { CaffeineIoC } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'

import { createWebApplication, Router } from '../index.js'

// QUERY is in Fastify's default method set, so a route declaring it needs nothing opted into.
describe('Router.query()', () => {
  it('registers a QUERY-method route that reads the request body', async () => {
    const routes = new Router('/query-test').query('/', { body: $t.Object({ term: $t.String() }) }, ctx => ({
      term: ctx.req.body().term,
    }))

    const app = createWebApplication({ container: new CaffeineIoC() }).mount(routes)
    await app.ready()

    const res = await app.fetch('/query-test', {
      method: 'QUERY',
      body: JSON.stringify({ term: 'cats' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ term: 'cats' })

    await app.close()
  })
})
