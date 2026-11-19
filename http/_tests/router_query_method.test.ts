import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { Router } from '../index.js'
import { node } from '../platform/node.testkit.js'

// QUERY is in the default matcher's method set, so a route declaring it needs nothing opted into.
describe('Router.query()', () => {
  it('registers a QUERY-method route that reads the request body', async () => {
    const routes = new Router('/query-test').query('/', { body: $t.Object({ term: $t.String() }) }, ctx => ({
      term: ctx.req.body().term,
    }))

    const app = createWebApplication({ adapter: node(), container: new CaffeineIoC() }).mount(routes)
    await app.bootstrap()

    const res = await app.request('/query-test', {
      method: 'QUERY',
      body: JSON.stringify({ term: 'cats' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ term: 'cats' })

    await app.close()
  })
})
