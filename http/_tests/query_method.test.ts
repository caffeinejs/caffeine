import Fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import { Controller, Args, Query, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { $p } from '../route_picker.js'

// Isolated file: registering a @Query controller forces a QUERY route onto every app built in the
// same module (the decorator registry is module-global), so it must not share a file with apps
// whose Fastify instance lacks addHttpMethod('QUERY').
describe('@Query verb (OpenAPI 3.2 QUERY method)', () => {
  it('registers a QUERY-method route that reads the request body', async () => {
    @Controller('/query-test')
    class QueryController {
      @Query('/')
      @Args([$p.body()])
      search(body: { term: string }) {
        return { term: body.term }
      }
    }
    void [QueryController]

    const instance = Fastify()
    instance.addHttpMethod('QUERY', { hasBody: true })
    const app = createWebApplication(fastifyAdapterFactory(instance))
    await app.ready()

    const res = await app.fetch('/query-test', {
      method: 'QUERY',
      body: JSON.stringify({ term: 'cats' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ term: 'cats' })
  })
})
