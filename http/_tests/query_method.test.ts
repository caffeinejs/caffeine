import { describe, it, expect } from 'vitest'

import { $p } from '../core/routing/picker.js'
import { Controller, Args, Query } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

// Isolated file: registering a @Query controller forces a QUERY route onto every app built in the
// same module, the decorator registry being module-global.
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

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.request('/query-test', {
      method: 'QUERY',
      body: JSON.stringify({ term: 'cats' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ term: 'cats' })
  })
})
