import { describe, it, expect } from 'vitest'

import { Controller, Args, Query, createWebApplication } from '../index.js'
import { $p } from '../routing/picker.js'

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
