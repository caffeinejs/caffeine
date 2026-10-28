import { describe, expect, it } from 'vitest'

import { createWebApplication, newRouter } from './index.js'

function helpers() {
  return newRouter('/helpers')
    .get('/bad-request', ctx => {
      ctx.badRequest()
    })
    .get('/not-found', ctx => {
      ctx.notFound()
    })
    .get('/unprocessable-entity', ctx => {
      ctx.unprocessableEntity()
    })
    .get('/not-found-with-body', ctx => {
      ctx.notFound({ reason: 'no such pet' })
    })
}

describe('Context error helpers', () => {
  // The same problem a thrown error renders to, so a client parses one shape whichever way the handler failed.
  it.each([
    ['bad-request', 400, 'Bad Request', 'ERR_HTTP_BAD_REQUEST'],
    ['not-found', 404, 'Not Found', 'ERR_HTTP_NOT_FOUND'],
    ['unprocessable-entity', 422, 'Unprocessable Entity', 'ERR_HTTP_UNPROCESSABLE_ENTITY'],
  ])('answers /%s without a body with a problem', async (path, status, title, code) => {
    const app = createWebApplication().mount(helpers())
    await app.bootstrap()

    const res = await app.request(`/helpers/${path}`)

    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title,
      status,
      detail: title,
      code,
      correlation_id: expect.stringMatching(/^req-/),
      timestamp: expect.any(String),
    })

    await app.close()
  })

  // The same negotiation as a thrown error: an agent asking for Markdown gets it from a helper too.
  it('answers a helper without a body in the format the client asked for', async () => {
    const app = createWebApplication().mount(helpers())
    await app.bootstrap()

    const res = await app.request('/helpers/not-found', { headers: { accept: 'text/markdown' } })

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(await res.text()).toContain('# Not Found\n\n## What happened\n\nNot Found\n')

    await app.close()
  })

  // A body the handler wrote is its own: no problem fields join it, and it is not relabelled as one.
  it('sends a body it was given as it stands, under its own media type', async () => {
    const app = createWebApplication().mount(helpers())
    await app.bootstrap()

    const res = await app.request('/helpers/not-found-with-body')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ reason: 'no such pet' })

    await app.close()
  })
})

describe('ContextRequest.id', () => {
  // The ID the request's log lines carry, so a handler can hand it to a downstream call or a support page.
  it('is the ID the server gave the request, taken from the header the server was told to trust', async () => {
    const app = createWebApplication()
      .server(() => ({ factory: { requestIdHeader: 'x-request-id' } }))
      .mount(newRouter('/whoami').get('/', ctx => ({ id: ctx.req.id })))
    await app.bootstrap()

    const res = await app.request('/whoami', { headers: { 'x-request-id': 'edge-91' } })

    expect(await res.json()).toEqual({ id: 'edge-91' })

    await app.close()
  })
})
