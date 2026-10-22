import { $t, compileValidator } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { newRouter } from '../new_router.js'

describe('a format a route checks', () => {
  // Configuration and messages are validated outside any request, where no server's Ajv can answer for a route's
  // format: it refuses there, as TypeBox refuses a format nobody registered, whatever a request accepted before.
  it('refuses every value checked outside a request, one a request accepted included', async () => {
    const format = 'caffeine-test-route-format'
    const codes = newRouter('/codes')
      .post('/')
      .schema({ body: $t.Object({ ttl: $t.Duration(), code: $t.String({ format }) }) })
      .handler(ctx => ({ body: ctx.req.body() }))
    const app = createWebApplication()
      .server(() => ({ factory: { ajv: { customOptions: { formats: { [format]: /^ok$/ } } } } }))
      .mount(codes)
    await app.bootstrap()

    try {
      const res = await app.fetch('/codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: '1m', code: 'ok' }),
      })
      expect(res.status).toBe(200)
    } finally {
      await app.close()
    }

    expect(compileValidator($t.String({ format }))('ok')).toEqual({
      ok: false,
      issues: [{ path: '', message: `Expected string to match '${format}' format`, code: expect.any(String) }],
    })
  })
})
