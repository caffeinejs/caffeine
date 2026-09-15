import { CaffeineIoC } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { createWebApplication, fastifyAdapterFactory, Router } from '../index.js'

// Isolated file: registering a QUERY route requires addHttpMethod('QUERY') on the Fastify instance
// before app.ready(), which other tests' apps don't opt into.
describe('Router.query()', () => {
  it('registers a QUERY-method route that reads the request body', async () => {
    const routes = new Router('/query-test').query('/', { body: $t.Object({ term: $t.String() }) }, ctx => ({
      term: ctx.req.body().term,
    }))

    const instance = fastify()
    instance.addHttpMethod('QUERY', { hasBody: true })
    const app = createWebApplication(fastifyAdapterFactory(instance), { container: new CaffeineIoC() }).mount(routes)
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
