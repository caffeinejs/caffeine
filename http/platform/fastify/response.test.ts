import { afterEach, describe, expect, it } from 'vitest'

import type { WebApplication } from '../../index.js'
import { createWebApplication, newRouter } from './index.js'

let app: WebApplication | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('answer', () => {
  // A cache updates the response it stored with the headers of a 304, so a length there would tell it the
  // representation is now empty; a 204 has no content to measure. Fastify's HEAD route writes one for any send
  // without a body.
  it.each([304, 204])('answers HEAD with %i and no body with no Content-Length', async status => {
    app = createWebApplication().mount(
      newRouter().get('/bodyless', ctx => {
        ctx.status(status)
        return undefined
      }),
    ) as WebApplication
    await app.bootstrap()

    const res = await app.request('/bodyless', { method: 'HEAD' })

    expect(res.status).toBe(status)
    expect(res.headers.get('content-length')).toBe(null)
    expect(res.headers.get('content-type')).toBe(null)
  })

  // The length a HEAD reports is that of the GET's body: an empty one is 0.
  it('answers HEAD with 200 and no body with Content-Length 0', async () => {
    app = createWebApplication().mount(newRouter().get('/empty', () => undefined)) as WebApplication
    await app.bootstrap()

    const res = await app.request('/empty', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('0')
  })
})
