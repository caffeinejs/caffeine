import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'

/**
 * A handler, or a `Responder` answering for one, reads back a response header before it sends: the type the route
 * declared, a header written further up, one it wrote itself.
 */

const routes = new Router('/headers')
routes
  .get('/produced')
  .produces('text/csv')
  .handler(ctx => `read: ${ctx.getHeader('content-type')}`)
routes
  .get('/declared')
  .header('x-api-version', '2')
  .header('x-region', ['eu-west', 'eu-north'])
  .handler(ctx => ({ version: ctx.getHeader('x-api-version'), region: ctx.getHeader('x-region') }))
routes.get('/written').handler(ctx => {
  const unset = ctx.getHeader('x-trace')
  ctx.header('x-trace', 'first')
  const written = ctx.getHeader('x-trace')
  ctx.header('x-trace', 'second')
  const replaced = ctx.getHeader('x-trace')
  ctx.appendHeader('x-step', 'parse').appendHeader('x-step', 'render')

  return { unset: unset ?? null, written, replaced, appended: ctx.getHeader('x-step') }
})
routes.get('/case').handler(ctx => {
  ctx.header('X-Request-Id', 'abc-123')
  return { read: ctx.getHeader('x-request-id') }
})

const app = createWebApplication().mount(routes)

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

describe('ctx.getHeader', () => {
  it('reads the type the route declared, before the handler writes anything', async () => {
    const res = await app.request('/headers/produced')

    expect(await res.text()).toMatch(/^read: text\/csv/)
  })

  it('reads a header the route declared, several values joined as one field line', async () => {
    const res = await app.request('/headers/declared')

    expect(await res.json()).toEqual({ version: '2', region: 'eu-west, eu-north' })
  })

  it('reads nothing for a header not written, then the value written, then the one that replaced it', async () => {
    const res = await app.request('/headers/written')

    expect(await res.json()).toEqual({
      unset: null,
      written: 'first',
      replaced: 'second',
      appended: 'parse, render',
    })
  })

  it('reads a header whatever case it was written or asked for in: field names are case-insensitive', async () => {
    const res = await app.request('/headers/case')

    expect(await res.json()).toEqual({ read: 'abc-123' })
  })
})
